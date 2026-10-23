/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#FFFBEB",
          100: "#FEF3C7",
          200: "#FDE68A",
          300: "#FCD34D",
          400: "#FACC15",
          500: "#EAB308",
          900: "#713F12",
        },
      },
      borderRadius: {
        card: "1.25rem",
      },
      boxShadow: {
        card: "0 4px 24px rgba(0,0,0,0.06)",
      },
    },
  },
  plugins: [],
};
