import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "off"
    }
  }
];
