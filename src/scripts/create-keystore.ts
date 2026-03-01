/**
 * Script CLI — Création du keystore chiffré
 * Usage : npm run keystore:create
 */
import { createKeystore } from '../utils/keystore.js';
import { CONFIG }         from '../config.js';

createKeystore(CONFIG.keystorePath)
  .then(() => {
    console.log('\n✅ Keystore créé avec succès.');
    console.log('   Vous pouvez maintenant supprimer MNEMONIC de votre .env');
    console.log('   et relancer le bot avec : npm start\n');
    process.exit(0);
  })
  .catch((err: Error) => {
    console.error('\n❌ Erreur:', err.message);
    process.exit(1);
  });
