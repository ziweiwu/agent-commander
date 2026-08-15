import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

type Variant = 'default' | 'primary' | 'danger' | 'compact' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

/**
 * The one button. Variants exist so the terminal key bar, the modal actions and
 * the topbar icons stay visually consistent without each module redefining a
 * button from scratch.
 */
export function Button({ variant = 'default', className, children, ...rest }: ButtonProps) {
  const classes = [styles.btn]
  if (variant !== 'default') classes.push(styles[variant] as string)
  if (className) classes.push(className)
  return (
    <button type="button" className={classes.join(' ')} {...rest}>
      {children}
    </button>
  )
}

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

export function Chip({ className, children, ...rest }: ChipProps) {
  return (
    <button type="button" className={[styles.chip, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </button>
  )
}
