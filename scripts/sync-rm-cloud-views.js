'use strict';

// assets/rm-cloud/cloud.html is the source of truth. Never edit its driver copies.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/rm-cloud/cloud.html'));
for (const driver of ['RM3_mini_cloud', 'RM4_mini_cloud', 'RM4_pro_cloud', 'RM_max']) {
  const view = driver === 'RM_max' ? fs.readFileSync(path.join(root, 'drivers', driver, 'pair/cloud.html')) : source;
  for (const mode of ['pair', 'repair']) {
    const directory = path.join(root, 'drivers', driver, mode);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'cloud.html'), view);
  }
}
