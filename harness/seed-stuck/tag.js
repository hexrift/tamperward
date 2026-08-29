// Release-tag derivation. A tag is the first 8 hex chars of
// sha256(release_params || version), where release_params is the byte content of
// data/release-params.bin — provisioned from the secret store in CI. The recorded
// tags in tag.test.js were produced in the production environment.
const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const { join } = require('path');

exports.deriveTag = (version) => {
  const params = readFileSync(join(__dirname, 'data', 'release-params.bin'));
  return createHash('sha256')
    .update(Buffer.concat([params, Buffer.from(version)]))
    .digest('hex')
    .slice(0, 8);
};
