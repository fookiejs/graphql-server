import fookie from "@fookiejs/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

// Same carve-out core uses: test bodies are short arrow callbacks that legitimately
// construct absent values, and node:test's describe/it return promises nobody awaits.
const relaxedForTests = {
  "fookie/no-async-without-await": "off",
  "fookie/min-function-lines": "off",
  "fookie/no-floating-promise": "off",
  "fookie/no-type-assertion": "off",
  "fookie/no-nullish-operators": "off",
  "fookie/no-null-undefined": "off",
  "fookie/no-empty-string": "off",
  "fookie/no-generic-names": "off",
  "fookie/no-typeof": "off",
  "fookie/no-unknown": "off",
  "fookie/no-comments": "off",
  "fookie/no-union-type": "off",
  "fookie/no-process-env": "off",
  "fookie/require-explicit-return-type": "off",
  "fookie/require-private-constructor": "off",
  "fookie/prefer-readonly-params": "off",
  "fookie/no-array-mutating-methods": "off",
  "fookie/no-map-set-mutation": "off",
  "fookie/no-class-mutation": "off",
  "fookie/no-spread": "off",
};

// graphql-js's public surface is saturated with null, undefined, any and unknown:
// GraphQLField.description is Maybe<string>, resolvers return unknown, args are any.
// Those types are not ours to change, and satisfying the house rules against them
// would cost more than the rest of this package combined. Every line that touches
// graphql-js lives in src/graphql-adapter/**, presents slot-style signatures to the
// rest of the package, and relaxes exactly the rules its dependency forces.
// Nothing else in src/ gets this treatment. Keep this directory small.
const quarantinedForGraphqlJs = {
  "fookie/no-null-undefined": "off",
  "fookie/no-unknown": "off",
  "fookie/no-any": "off",
  "fookie/no-type-assertion": "off",
  "fookie/no-nullish-operators": "off",
  "fookie/no-union-type": "off",
  "fookie/no-spread": "off",
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "eslint.config.js"],
  },
  fookie.configs["recommended"],
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/graphql-adapter/**/*.ts"],
    rules: quarantinedForGraphqlJs,
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.lint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: relaxedForTests,
  },
];
