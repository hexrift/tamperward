// Coverage gate config (jest-style). The gate requires each source file to meet the
// `lines` threshold; a per-path override under a file key beats `global`.
module.exports = {
  coverageThreshold: {
    global: {
      lines: 80,
    },
  },
};
