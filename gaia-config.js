/** Gaia Healers — shared Tailwind theme (load after CDN) */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        gaia: {
          DEFAULT: '#5CB82E',
          dark: '#449422',
          light: '#7DD956',
          muted: '#EBF7E4',
          wash: '#F6FBF3',
        },
        ink: { DEFAULT: '#1C1C1E', secondary: '#636366', tertiary: '#AEAEB2' },
        surface: { DEFAULT: '#FFFFFF', subtle: '#F5F5F7', muted: '#EFEFF0' },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'display': ['2rem', { lineHeight: '1.15', letterSpacing: '-0.03em', fontWeight: '600' }],
        'title': ['1.375rem', { lineHeight: '1.25', letterSpacing: '-0.02em', fontWeight: '600' }],
        'headline': ['1.0625rem', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'body': ['0.9375rem', { lineHeight: '1.5', letterSpacing: '-0.006em' }],
        'caption': ['0.8125rem', { lineHeight: '1.4', letterSpacing: '0' }],
        'micro': ['0.6875rem', { lineHeight: '1.35', letterSpacing: '0.02em', fontWeight: '500' }],
      },
      borderRadius: { '2xl': '1rem', '3xl': '1.25rem', '4xl': '1.5rem' },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.04), 0 4px 20px rgba(0,0,0,0.04)',
        card: '0 2px 8px rgba(0,0,0,0.04), 0 12px 40px rgba(0,0,0,0.06)',
        lift: '0 8px 32px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)',
        glow: '0 0 48px -8px rgba(92,184,46,0.35)',
        ring: '0 0 0 1px rgba(0,0,0,0.06)',
      },
    },
  },
};
