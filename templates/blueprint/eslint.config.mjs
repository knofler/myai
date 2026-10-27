// Next.js 16's `eslint-config-next` ships native ESLint flat-config arrays
// (see node_modules/eslint-config-next/dist/*.js — each subpath exports a
// plain array of flat config objects). Import them directly and spread them
// in, rather than going through @eslint/eslintrc's FlatCompat legacy bridge:
// forcing this flat-native package through FlatCompat's legacy config
// validator throws "TypeError: Converting circular structure to JSON" (the
// validator chokes on eslint-plugin-react's flat `configs.flat` object,
// which self-references). FlatCompat is still needed for genuinely
// eslintrc-only shareable configs, but `eslint-config-next` isn't one of
// those any more — don't add @eslint/eslintrc back for this package.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: ["node_modules/**", ".next/**", "coverage/**", "tests/e2e/**"],
  },
];

export default eslintConfig;
