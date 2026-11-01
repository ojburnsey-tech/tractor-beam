import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
const eslintConfig = defineConfig([
    ...nextVitals,
    ...nextTs,
    globalIgnores([
        "dist/**",
        ".vinext/**",
        ".wrangler/**",
        ".sites-runtime/**",
        "outputs/**",
        "work/**",
    ]),
    {
        files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
        rules: {
            "@typescript-eslint/no-unused-vars": "off",
            "react-hooks/purity": "off",
            "react-hooks/set-state-in-effect": "off",
        },
    },
]);
export default eslintConfig;
