'use strict';
require('../platform/entry.cjs').post('github').catch(() => { console.error('::error::Device Farm post failed; inspect preserved run artifacts'); process.exitCode=1; });
