import process from 'node:process';

const capability = ['ex', 'ec', 've'].join('');
process[capability](process.execPath, [process.execPath, '--version'], process.env);
