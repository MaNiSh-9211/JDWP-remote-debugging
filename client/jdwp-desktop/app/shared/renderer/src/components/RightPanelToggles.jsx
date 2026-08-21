/** Which right drawers are visible — stacked top→bottom: Code, BP, HTTP. Shown in each panel header (right side only). */
const ITEMS = [
  { id: 'source', label: 'Code' },
  { id: 'bp', label: 'BP' },
  { id: 'http', label: 'HTTP' },
]

export default function RightPanelToggles({ panels, onTogglePanel }) {
  return (
    <div className="right-panel-toggles" role="group" aria-label="Open side panels (stacked)">
      {ITEMS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={`right-panel-toggles__btn${panels[id] ? ' right-panel-toggles__btn--on' : ''}`}
          onClick={() => onTogglePanel(id)}
          title={panels[id] ? `Hide ${label} panel` : `Show ${label} panel below others`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
