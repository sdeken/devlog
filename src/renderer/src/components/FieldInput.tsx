import type { ExtensionField } from '@devlog/core'

/** One extension-declared field, edited the way its type says. Values are strings ("true"/"false" for checkboxes). */
export function FieldInput({ id, field, value, onChange, disabled }: { id: string; field: ExtensionField; value: string; onChange: (v: string) => void; disabled?: boolean }): React.JSX.Element {
  switch (field.type) {
    case 'checkbox':
      return (
        <label className="check">
          <input id={id} type="checkbox" checked={value === 'true'} disabled={disabled} onChange={(ev) => onChange(ev.target.checked ? 'true' : 'false')} /> {field.label}
        </label>
      )
    case 'select':
      return (
        <select id={id} value={value} disabled={disabled} onChange={(ev) => onChange(ev.target.value)}>
          <option value="">{field.placeholder ?? '—'}</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'textarea':
      return <textarea id={id} rows={3} value={value} placeholder={field.placeholder} disabled={disabled} onChange={(ev) => onChange(ev.target.value)} />
    default:
      return (
        <input
          id={id}
          type={field.type === 'url' ? 'url' : field.type === 'email' ? 'email' : field.type === 'number' ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder}
          disabled={disabled}
          spellCheck={false}
          onChange={(ev) => onChange(ev.target.value)}
        />
      )
  }
}

/** Label (with a required mark) above the input, description below. Checkboxes carry their own label. */
export function FieldRow({ id, field, value, onChange, problem, disabled }: { id: string; field: ExtensionField; value: string; onChange: (v: string) => void; problem?: string | null; disabled?: boolean }): React.JSX.Element {
  return (
    <div className={`field ext-field${problem ? ' has-problem' : ''}`} data-field={field.key}>
      {field.type !== 'checkbox' && (
        <label htmlFor={id}>
          {field.label}
          {field.required && <span className="ext-required" title="Required"> *</span>}
        </label>
      )}
      <FieldInput id={id} field={field} value={value} onChange={onChange} disabled={disabled} />
      {problem ? <p className="form-error ext-field-problem">{problem}</p> : field.description ? <p className="hint">{field.description}</p> : null}
    </div>
  )
}
