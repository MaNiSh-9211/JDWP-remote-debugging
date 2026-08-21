import { useId } from 'react'

/** App mark — accent copper / amber only (no green). */
export default function StudioLogo({ className = '' }) {
  const gid = useId().replace(/:/g, '')
  const gradId = `jdwp-logo-grad-${gid}`
  return (
    <svg
      className={className}
      width="26"
      height="26"
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#e8a050" />
          <stop offset="55%" stopColor="#c45c26" />
          <stop offset="100%" stopColor="#8f4420" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#121410" stroke={`url(#${gradId})`} strokeWidth="1.5" />
      <path
        d="M10 22V10h3.2v4.2L18 10h3.8l-5.2 5.4 5.4 6.6H18l-3.8-5-1 1.1V22H10z"
        fill={`url(#${gradId})`}
      />
      <circle cx="24" cy="9" r="2.25" fill="#e8a050" opacity="0.95" />
    </svg>
  )
}
