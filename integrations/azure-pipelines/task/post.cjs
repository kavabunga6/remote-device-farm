'use strict';
require('../../platform/entry.cjs').post('azure').catch(() => { console.error('##vso[task.complete result=Failed;]Device Farm post failed; inspect preserved run artifacts'); process.exitCode=1; });
