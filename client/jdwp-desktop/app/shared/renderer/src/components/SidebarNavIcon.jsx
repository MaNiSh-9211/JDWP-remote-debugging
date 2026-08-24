/** Activity-bar style icons (outline, VS Code–like). */
export default function SidebarNavIcon({ id }) {
  const s = {
    className: 'sidebar-nav-icon__svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  switch (id) {
    case 'debugger':
      return (
        <svg {...s} aria-hidden>
          <path d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4l1.4-1.4M17 7l1.4-1.4" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      )
    case 'session':
      return (
        <svg {...s} aria-hidden>
          <path d="M10 7h4v3h-4zM8 12h8v7H8z" />
          <path d="M12 12v2M10 16h4" />
        </svg>
      )
    case 'breakpoints':
      return (
        <svg {...s} aria-hidden>
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2.25" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'cluster':
      return (
        <svg {...s} aria-hidden>
          <circle cx="12" cy="7" r="3" />
          <circle cx="7" cy="16" r="3" />
          <circle cx="17" cy="16" r="3" />
          <path d="M10.2 9.2L8.8 13M13.8 9.2l1.4 3.8M10 16h4" />
        </svg>
      )
    case 'timelens':
      return (
        <svg {...s} aria-hidden>
          <circle cx="12" cy="13" r="7" />
          <path d="M12 13V8M12 13l3 2" />
          <path d="M9 2h6" />
        </svg>
      )
    case 'insights':
      return (
        <svg {...s} aria-hidden>
          <path d="M4 19h16M4 15l4-4 4 3 5-6 3 3" />
          <path d="M4 19V5" />
        </svg>
      )
    default:
      return (
        <svg {...s} aria-hidden>
          <circle cx="12" cy="12" r="8" />
        </svg>
      )
  }
}
