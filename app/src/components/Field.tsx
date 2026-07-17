import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  /** Must match the wrapped control's id so the label associates with it. */
  htmlFor: string;
  /** Optional help text under the control. */
  help?: string;
  /** id for the help paragraph, so a control can point aria-describedby at it. */
  helpId?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A label + control (+ optional help) group, formalizing the `.options-field`
 * idea into one primitive. The control's own min-height (40px, from the global
 * input/select rule) is preserved — this only supplies label association and
 * vertical rhythm.
 */
export default function Field({ label, htmlFor, help, helpId, className, children }: FieldProps) {
  return (
    <div className={['sc-field', className].filter(Boolean).join(' ')}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && (
        <p className="sc-field-help" id={helpId}>
          {help}
        </p>
      )}
    </div>
  );
}
