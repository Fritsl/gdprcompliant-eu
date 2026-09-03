// Stands in for the `server-only` package when the web app's server modules are
// imported by an integration test. The real package throws outside a React server
// bundle; here the modules run on the server by definition.
export {};
