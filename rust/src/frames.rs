//! Frame diffing. Port of `src/server/frames.ts`.

use crate::types::{ChangedRow, Frame, Geom};

/// Build the smallest frame that turns `prev` into `next`.
///
/// The Attach view repaints a captured pane ~7x/second. Rewriting all 47 rows
/// each time makes xterm.js flicker and wastes bandwidth, so we send only the
/// rows that actually changed. A `None` `prev` (first paint, or a geometry
/// change) forces a full frame.
pub fn build_frame(session_id: &str, prev: Option<&[String]>, next: &[String], geom: Geom) -> Frame {
    let base = Frame {
        session_id: session_id.to_string(),
        cols: geom.cols,
        rows: geom.rows,
        cursor_x: geom.cursor_x,
        cursor_y: geom.cursor_y,
        lines: None,
        changed: None,
    };
    match prev {
        Some(p) if p.len() == next.len() => {
            let changed = next
                .iter()
                .enumerate()
                .filter(|(i, line)| p[*i] != **line)
                .map(|(row, text)| ChangedRow { row, text: text.clone() })
                .collect();
            Frame { changed: Some(changed), ..base }
        }
        _ => Frame { lines: Some(next.to_vec()), ..base },
    }
}

/// True when a frame carries no visual change and need not be sent at all.
pub fn is_noop(frame: &Frame, prev_cursor: Option<(usize, usize)>) -> bool {
    if frame.lines.is_some() {
        return false;
    }
    if frame.changed.as_ref().map(|c| c.len()).unwrap_or(0) > 0 {
        return false;
    }
    match prev_cursor {
        Some((x, y)) => x == frame.cursor_x && y == frame.cursor_y,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(count: usize, tag: &str) -> Vec<String> {
        (0..count).map(|i| format!("row {i} {tag}")).collect()
    }

    /// Enough rows to tell a sparse frame from a full one, few enough to write
    /// the expected output out by hand.
    const PANE_ROWS: usize = 3;

    const SMALL_PANE: Geom = Geom { cols: 80, rows: PANE_ROWS, cursor_x: 0, cursor_y: 0 };

    #[test]
    fn full_frame_when_prev_is_none() {
        let next = rows(PANE_ROWS, "a");
        let f = build_frame("s", None, &next, SMALL_PANE);
        assert_eq!(f.lines.as_ref().unwrap().len(), PANE_ROWS);
        assert!(f.changed.is_none());
    }

    #[test]
    fn full_frame_when_row_count_changes() {
        let prev = rows(PANE_ROWS - 1, "a");
        let next = rows(PANE_ROWS, "a");
        let f = build_frame("s", Some(&prev), &next, SMALL_PANE);
        assert!(f.lines.is_some(), "geometry change must force a full repaint");
    }

    #[test]
    fn sparse_frame_lists_only_changed_rows() {
        let prev = rows(PANE_ROWS, "a");
        let mut next = prev.clone();
        next[1] = "changed".into();
        let f = build_frame("s", Some(&prev), &next, SMALL_PANE);
        let changed = f.changed.unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].row, 1);
        assert_eq!(changed[0].text, "changed");
    }

    /// The pane the Node microbenchmark ran against, so the two are compared on
    /// identical input: 47 rows of 60-100 characters with ANSI colour runs,
    /// which is the shape a real agent's pane has.
    const BENCH_ROWS: usize = 47;
    /// A full 256-colour cycle, so neighbouring rows do not share an escape run
    /// and the diff cannot get cheap by accident.
    const BENCH_COLOURS: usize = 256;
    /// Row widths run from this up to `+ BENCH_WIDTH_SPREAD`, the range a real
    /// capture shows.
    const BENCH_MIN_WIDTH: usize = 60;
    const BENCH_WIDTH_SPREAD: usize = 40;
    /// Two rows somewhere in the middle, which is what a spinner and a status
    /// line change between frames — the "2 of 47 rows" case.
    const FIRST_CHANGED_ROW: usize = 12;
    const SECOND_CHANGED_ROW: usize = 30;

    fn bench_rows(seed: usize) -> Vec<String> {
        (0..BENCH_ROWS)
            .map(|i| {
                format!(
                    "\u{001b}[38;5;{}mrow {} {}\u{001b}[0m",
                    (i + seed) % BENCH_COLOURS,
                    i,
                    "x".repeat(BENCH_MIN_WIDTH + ((i * seed) % BENCH_WIDTH_SPREAD))
                )
            })
            .collect()
    }

    /// Timing counterpart to the Node microbenchmark, on identical input.
    ///
    /// Ignored by default because a timing assertion is a flaky test; run it
    /// deliberately with:
    ///   cargo test --release -- --ignored --nocapture bench_build_frame
    ///
    /// The Node baseline on this machine, same geometry and same change
    /// pattern: 0.490 us worst case, 0.373 us all-rows-changed, 0.031 us full
    /// repaint. This exists so the one genuinely hot function in the server is
    /// compared like for like rather than by assertion.
    #[test]
    #[ignore]
    fn bench_build_frame() {
        use std::time::Instant;

        let geom = Geom { cols: 120, rows: BENCH_ROWS, cursor_x: 10, cursor_y: 20 };
        let prev = bench_rows(1);
        let mut few = bench_rows(1);
        few[FIRST_CHANGED_ROW] = "changed row".into();
        few[SECOND_CHANGED_ROW] = "another".into();
        let all = bench_rows(2);

        let run = |label: &str, prev: Option<&[String]>, next: &[String]| {
            for _ in 0..1000 {
                std::hint::black_box(build_frame("s", prev, next, geom));
            }
            let iters = 200_000;
            let started = Instant::now();
            for _ in 0..iters {
                std::hint::black_box(build_frame("s", prev, next, geom));
            }
            let micros = started.elapsed().as_secs_f64() * 1e6 / iters as f64;
            println!("  {label:<40} {micros:>9.3} us/op");
        };

        println!("=== rust build_frame (47-row pane) ===");
        run("build_frame - 2 of 47 rows changed", Some(&prev), &few);
        run("build_frame - all 47 rows changed", Some(&prev), &all);
        run("build_frame - full repaint (prev=None)", None, &all);
    }

    #[test]
    fn reports_an_empty_delta_when_nothing_moved() {
        // Not a full frame, and not nothing: `is_noop` is what decides whether
        // this is worth sending, and it needs a frame to decide about.
        let prev = rows(PANE_ROWS, "a");
        let f = build_frame("s", Some(&prev), &prev, SMALL_PANE);
        assert_eq!(f.changed.as_ref().unwrap().len(), 0);
        assert!(f.lines.is_none());
    }

    #[test]
    fn always_carries_current_geometry_and_cursor() {
        // The Attach view sizes itself from these. A sparse frame that omitted
        // them would leave the terminal drawn at whatever the first paint said.
        const WIDE_PANE: Geom = Geom { cols: 150, rows: 47, cursor_x: 2, cursor_y: 44 };
        let prev = rows(1, "a");
        let f = build_frame("s", Some(&prev), &prev, WIDE_PANE);
        assert_eq!(
            (f.cols, f.rows, f.cursor_x, f.cursor_y),
            (WIDE_PANE.cols, WIDE_PANE.rows, WIDE_PANE.cursor_x, WIDE_PANE.cursor_y)
        );
        assert_eq!(f.session_id, "s");
    }

    /// INV-4: an idle pane must not generate WebSocket traffic 7x a second.
    #[test]
    fn inv4_suppresses_a_frame_with_no_row_or_cursor_change() {
        let prev = rows(PANE_ROWS, "a");
        let f = build_frame("s", Some(&prev), &prev, SMALL_PANE);
        assert!(is_noop(&f, Some((0, 0))));
    }

    #[test]
    fn noop_only_when_nothing_moved_including_the_cursor() {
        let prev = rows(PANE_ROWS, "a");
        let moved = build_frame("s", Some(&prev), &prev, Geom { cursor_x: 5, ..SMALL_PANE });
        assert!(!is_noop(&moved, Some((0, 0))), "a moved cursor is a visual change");

        let f = build_frame("s", Some(&prev), &prev, SMALL_PANE);
        assert!(is_noop(&f, Some((0, 0))));
        assert!(!is_noop(&f, Some((1, 0))), "a moved cursor is a visual change");
        // The very first delta, with no cursor known yet, cannot be claimed as
        // a noop: there is nothing to have not moved from.
        assert!(!is_noop(&f, None), "no previous cursor means we cannot claim noop");

        // A full frame is never suppressed — it is the resync.
        let full = build_frame("s", None, &prev, SMALL_PANE);
        assert!(!is_noop(&full, Some((0, 0))));
    }
}
