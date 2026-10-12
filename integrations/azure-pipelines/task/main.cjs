'use strict';
require('../../platform/entry.cjs').main('azure').catch(() => { console.error('##vso[task.complete result=Failed;]Device Farm main failed; inspect preserved run artifacts'); process.exitCode=1; });
