// Kept in sync with package.json by cli/__tests__/version.test.ts.
//
// A literal rather than a runtime read of package.json: the published package
// ships only dist/, so resolving the manifest from compiled output means
// walking out of the tarball's own layout, and the `with { type: "json" }`
// import form does not compile under this repo's module target. The test is
// what makes the literal safe.
export const VERSION = "0.3.0";
