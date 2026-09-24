/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  roots: ["<rootDir>/test"],
  // Source imports carry a `.js` extension so the emitted ESM actually resolves
  // under Node. ts-jest reads the TypeScript, so map the extension back off.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: "tsconfig.json" }],
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/index.ts"],
  clearMocks: true,
};
