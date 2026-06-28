const { execSync } = require('child_process');

exports.default = async (context) => {
  execSync(`chmod -R a+rX "${context.appOutDir}"`);
};
