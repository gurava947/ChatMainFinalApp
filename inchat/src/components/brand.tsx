export function InLogo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="InChat"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id="in-tricolour" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff9933" />
          <stop offset="0.5" stopColor="#ffffff" />
          <stop offset="1" stopColor="#138808" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="#0e1012" stroke="url(#in-tricolour)" strokeWidth="2" />
      <text
        x="24"
        y="31"
        textAnchor="middle"
        fontFamily="var(--font-ui)"
        fontSize="19"
        fontWeight="700"
        fill="url(#in-tricolour)"
      >
        IN
      </text>
      <circle cx="24" cy="37" r="1.6" fill="#0b0f14" opacity="0.5" />
    </svg>
  );
}
