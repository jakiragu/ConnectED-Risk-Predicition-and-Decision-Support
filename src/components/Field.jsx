export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/**
 * allLabel adds an "All …" choice with the value '' (a filter that means
 * "no filter"); placeholder is a prompt for a required choice.
 */
export function Select({ id, value, onChange, options, placeholder, allLabel, ...rest }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {allLabel ? <option value="">{allLabel}</option> : placeholder && <option value="">{placeholder}</option>}
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o} value={o}>{o}</option>
        ) : (
          <option key={o.value} value={o.value}>{o.label}</option>
        )
      )}
    </select>
  );
}