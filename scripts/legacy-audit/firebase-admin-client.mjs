// Cliente Firebase Admin compartilhado pelos scripts de auditoria/migração.
// Somente leitura por convenção de uso — nada aqui chama .set()/.update()/.delete().
//
// Duas formas de credencial são aceitas (ver .env.example):
//   - GOOGLE_APPLICATION_CREDENTIALS: caminho de arquivo, fora do repo.
//   - FIREBASE_ADMIN_CREDENTIALS_JSON: o JSON do service account em base64,
//     útil em CI (secret) onde não dá para montar um arquivo com facilidade.
//
// Nunca lança half-inicializado: se nenhuma das duas existir, falha cedo com
// uma mensagem clara em vez de deixar o firebase-admin tentar (e falhar) a
// autenticação implícita do ambiente.
import 'dotenv/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

function loadCredential() {
  const { GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_ADMIN_CREDENTIALS_JSON } = process.env;

  if (FIREBASE_ADMIN_CREDENTIALS_JSON) {
    const json = Buffer.from(FIREBASE_ADMIN_CREDENTIALS_JSON, 'base64').toString('utf8');
    return cert(JSON.parse(json));
  }

  if (GOOGLE_APPLICATION_CREDENTIALS) {
    // firebase-admin já sabe ler esse caminho sozinho via applicationDefault(),
    // mas usar cert() explícito aqui deixa o erro de arquivo ausente/ inválido
    // mais claro do que a mensagem genérica do ADC.
    return cert(GOOGLE_APPLICATION_CREDENTIALS);
  }

  throw new Error(
    'Nenhuma credencial do Firebase encontrada. Defina GOOGLE_APPLICATION_CREDENTIALS ' +
      '(caminho de arquivo) ou FIREBASE_ADMIN_CREDENTIALS_JSON (base64) no .env — ' +
      'ver .env.example. Nunca peça ou cole a credencial diretamente no chat.'
  );
}

let app;
function getApp() {
  if (!app) {
    app = getApps()[0] ?? initializeApp({ credential: loadCredential() });
  }
  return app;
}

export function getLegacyFirestore() {
  return getFirestore(getApp());
}

export function getLegacyAuth() {
  return getAuth(getApp());
}

// O Firestore free tier (Spark) tem cota diária de leitura — coleções grandes
// devem ser lidas em páginas, nunca com um único .get() sem limite, para não
// estourar a cota nem segurar a conexão por muito tempo. `pageSize` pequeno
// o bastante para relatórios (não é hot path, não precisa ser rápido).
export async function* paginate(collectionRef, { pageSize = 300 } = {}) {
  let lastDoc;
  for (;;) {
    let query = collectionRef.orderBy('__name__').limit(pageSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snapshot = await query.get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) yield doc;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.docs.length < pageSize) return;
  }
}
