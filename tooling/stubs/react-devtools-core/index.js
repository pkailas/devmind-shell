// Stub for bun build --compile.
// Ink imports this package eagerly but only uses it when isDev() is true (DEV=true env var).
// In our production build, isDev() always returns false, so the exports here are never called.
module.exports = {
  connectToDevTools: function () {},
  initialize: function () {},
};
module.exports.default = module.exports;
