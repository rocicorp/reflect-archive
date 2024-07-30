import {makeRollupOptions} from 'shared/src/tool/rollup-dts.js';

export default makeRollupOptions(
  'out/.dts/mod.d.ts',
  'out/reflect-shared.d.ts',
);
