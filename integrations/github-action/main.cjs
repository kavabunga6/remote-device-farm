'use strict';
require('../platform/entry.cjs').main('github').catch(() => { console.error('::error::Device Farm main failed; inspect preserved run artifacts'); process.exitCode=1; });
