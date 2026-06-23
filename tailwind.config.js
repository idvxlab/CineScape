/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1f2430',
        brand: { DEFAULT: '#2f5bff', dark: '#1f44d6', soft: '#eaf0ff' },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04)',
        panel: '0 4px 18px rgba(16,24,40,.08)',
      },
    },
  },
  plugins: [],
}
