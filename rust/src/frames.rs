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

    fn rows(n: usize, tag: &str) -> Vec<String> {
        (0..n).map(|i| format!("row {i} {tag}")).collect()
    }

    const G: Geom = Geom { cols: 80, rows: 3, cursor_x: 0, cursor_y: 0 };

    #[test]
    fn full_frame_when_prev_is_none() {
        let next = rows(3, "a");
        let f = build_frame("s", None, &next, G);
        assert_eq!(f.lines.as_ref().unwrap().len(), 3);
        assert!(f.changed.is_none());
    }

    #[test]
    fn full_frame_when_row_count_changes() {
        let prev = rows(2, "a");
        let next = rows(3, "a");
        let f = build_frame("s", Some(&prev), &next, G);
        assert!(f.lines.is_some(), "geometry change must force a full repaint");
    }

    #[test]
    fn sparse_frame_lists_only_changed_rows() {
        let prev = rows(3, "a");
        let mut next = prev.clone();
        next[1] = "changed".into();
        let f = build_frame("s", Some(&prev), &next, G);
        let changed = f.changed.unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].row, 1);
        assert_eq!(changed[0].text, "changed");
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

        // 47 rows, ~60-100 chars, with ANSI colour runs — the real pane shape.
        let mk = |seed: usize| -> Vec<String> {
            (0..47)
                .map(|i| {
                    format!(
                        "\u{001b}[38;5;{}mrow {} {}\u{001b}[0m",
                        (i + seed) % 256,
                        i,
                        "x".repeat(60 + ((i * seed) % 40))
                    )
                })
                .collect()
        };
        let geom = Geom { cols: 120, rows: 47, cursor_x: 10, cursor_y: 20 };
        let prev = mk(1);
        let mut few = mk(1);
        few[12] = "changed row".into();
        few[30] = "another".into();
        let all = mk(2);

        let run = |label: &str, prev: Option<&[String]>, next: &[String]| {
            for _ in 0..1000 {
                std::hint::black_box(build_frame("s", prev, next, geom));
            }
            let iters = 200_000;
            let t0 = Instant::now();
            for _ in 0..iters {
                std::hint::black_box(build_frame("s", prev, next, geom));
            }
            let us = t0.elapsed().as_secs_f64() * 1e6 / iters as f64;
            println!("  {label:<40} {us:>9.3} us/op");
        };

        println!("=== rust build_frame (47-row pane) ===");
        run("build_frame - 2 of 47 rows changed", Some(&prev), &few);
        run("build_frame - all 47 rows changed", Some(&prev), &all);
        run("build_frame - full repaint (prev=None)", None, &all);
    }

    #[test]
    fn noop_only_when_nothing_moved_including_the_cursor() {
        let prev = rows(3, "a");
        let f = build_frame("s", Some(&prev), &prev, G);
        assert!(is_noop(&f, Some((0, 0))));
        assert!(!is_noop(&f, Some((1, 0))), "a moved cursor is a visual change");
        assert!(!is_noop(&f, None), "no previous cursor means we cannot claim noop");
    }
}
