// @ts-check
import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "drizzle.config.ts", "scripts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/interface-name-prefix": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Several methods are declared async purely to satisfy a port they implement — see the
      // note on `TurnkeyKeyVault.signTypedData` for why that is deliberate.
      "@typescript-eslint/require-await": "off",
      // `Hex | string` reads as "already bytes, or plain text" at the signing seam. The union
      // collapses to `string`, and saying so is the point.
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // `JSON.parse` and a `JSON.stringify` replacer are `any` by definition; warn at those
      // boundaries rather than forcing a cast that asserts more than is known.
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
    },
  },
  {
    // A decoded HTTP response is genuinely untyped, and a test asserting on one field of it
    // reads far better than a declared shape per endpoint. The unsafe-* family is therefore
    // off here and nowhere else.
    files: ["**/*.spec.ts", "**/*.e2e-spec.ts", "src/testing/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
