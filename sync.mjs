import { sync } from './lib/hevy.mjs';

sync({ full: process.argv.includes('--full'), log: m => console.log(m) }).catch(err => {
  console.error(err.message);
  process.exit(1);
});
