/** Tailwind v4 is configured entirely via PostCSS — no tailwind.config.js needed.
 *  Theme tokens live in app/globals.css under the `@theme` block. */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
