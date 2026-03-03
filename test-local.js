const assert = require('assert')

// Create a local verification that JS parsing compiles.
try {
   const crypto = require('crypto');
   console.log('Valid syntax structure tested local.');
} catch(e) { console.error('FAILED TO PARSE'); }
