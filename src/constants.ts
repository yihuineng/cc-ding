import { strUtil } from 'utils-ok';


const platform = require('os').platform();
const isOSX = platform === 'darwin';

export const DEBUG: any = strUtil.safeBoolean(process.env.DEBUG || '');
export const DEV: any = isOSX;
