/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Blood-red palette: class names keep their slots, values are red.
        violet: { DEFAULT: '#E5192D', soft: '#FF4D5A', 100: '#3A0A0F', 300: '#FF6B75', 400: '#FF4D5A' },
        cyan: { DEFAULT: '#7A0B14', soft: '#A3121D', 100: '#2B0508', 300: '#FF9AA4', 400: '#FF6B75' },
        ink: {
          950: '#07090F',
          900: '#0B0E16',
          850: '#0E121C',
          800: '#131926',
          700: '#1B2233',
          600: '#2A3348',
        },
        glass: {
          bg: 'rgba(19,25,38,0.72)',
          border: 'rgba(255,255,255,0.07)',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '16px',
        btn: '10px',
      },
      boxShadow: {
        'glow-violet': '0 0 24px rgba(229,25,45,0.4)',
        'glow-cyan': '0 0 24px rgba(122,11,20,0.45)',
        'inset-top': 'inset 0 1px 0 rgba(255,255,255,0.22)',
      },
      keyframes: {
        orb: {
          '0%,100%': { transform: 'translate(0,0) scale(1)' },
          '33%': { transform: 'translate(6vw,-4vh) scale(1.12)' },
          '66%': { transform: 'translate(-5vw,5vh) scale(0.94)' },
        },
        drain: {
          from: { transform: 'scaleX(1)' },
          to: { transform: 'scaleX(0)' },
        },
        pulseDot: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        orb: 'orb 24s ease-in-out infinite',
        drain: 'drain 3.2s linear forwards',
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
