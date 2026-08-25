#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { platforms } = require('./release-platforms.cjs');
const matrix = { include: platforms.map(platform => ({ os: platform.runner, rid: platform.rid, target: platform.target, binary: platform.sourceBinary, staged: platform.stagedBinary, artifact: platform.artifact })) };
const value = JSON.stringify(matrix);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'matrix=' + value + '\n');
else console.log(value);
