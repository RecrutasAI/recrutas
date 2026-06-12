/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // This is the crucial part for ts-jest with ESM
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  // Point to your backend tests
  testMatch: [
    '**/server/**/*.test.ts',
    '**/test/**/*.test.js',
    '**/test/**/*.test.ts'
  ],
};