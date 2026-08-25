import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Read-only by construction: this module never returns a raw Firestore/Auth
// instance, only the specific read operations below, so a caller has no way
// to reach .set()/.update()/.delete() even by mistake. The Admin SDK ignores
// Firestore security rules entirely, so this is the only safeguard against
// an accidental write to production during audit/migration dry-runs.

function loadCredential() {
  if (process.env.FIREBASE_ADMIN_CREDENTIALS_JSON) {
    const json = Buffer.from(process.env.FIREBASE_ADMIN_CREDENTIALS_JSON, 'base64').toString('utf8');
    return cert(JSON.parse(json));
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }
  throw new Error(
    'Nenhuma credencial do Firebase Admin encontrada. Defina FIREBASE_ADMIN_CREDENTIALS_JSON ' +
      '(JSON da service account em base64) ou GOOGLE_APPLICATION_CREDENTIALS (caminho para o arquivo) ' +
      'antes de rodar este script. Veja .env.example.'
  );
}

let app;
function getApp() {
  if (!app) {
    app = getApps()[0] ?? initializeApp({
      credential: loadCredential(),
      projectId: process.env.FIREBASE_PROJECT_ID || 'farmhmmv',
    });
  }
  return app;
}

/** Lista os ids de todas as top-level collections do projeto. */
export async function listCollectionIds() {
  const db = getFirestore(getApp());
  const collections = await db.listCollections();
  return collections.map((c) => c.id);
}

/** Contagem exata de documentos de uma collection (via aggregation query). */
export async function countDocuments(collectionName) {
  const db = getFirestore(getApp());
  const snapshot = await db.collection(collectionName).count().get();
  return snapshot.data().count;
}

/**
 * Itera todos os documentos de uma collection em páginas, sem nunca expor o
 * QueryDocumentSnapshot bruto (que carrega uma .ref com métodos de escrita).
 * Retorna apenas { id, data } por documento.
 */
export async function* iterateDocuments(collectionName, { pageSize = 500 } = {}) {
  const db = getFirestore(getApp());
  let query = db.collection(collectionName).orderBy('__name__').limit(pageSize);
  for (;;) {
    const snapshot = await query.get();
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      yield { id: doc.id, data: doc.data() };
    }
    const last = snapshot.docs[snapshot.docs.length - 1];
    query = db.collection(collectionName).orderBy('__name__').startAfter(last.id).limit(pageSize);
  }
}

/** Busca um único documento por id; retorna null se não existir. */
export async function getDocument(collectionName, id) {
  const db = getFirestore(getApp());
  const doc = await db.collection(collectionName).doc(id).get();
  return doc.exists ? { id: doc.id, data: doc.data() } : null;
}

/**
 * Lista todos os usuários do Firebase Auth (uid, email, disabled, metadata),
 * paginando internamente. Nunca expõe createUser/updateUser/deleteUser.
 */
export async function listAllAuthUsers() {
  const auth = getAuth(getApp());
  const users = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    for (const u of result.users) {
      users.push({
        uid: u.uid,
        email: u.email ?? null,
        disabled: u.disabled,
        emailVerified: u.emailVerified,
        creationTime: u.metadata.creationTime,
        lastSignInTime: u.metadata.lastSignInTime,
      });
    }
    pageToken = result.pageToken;
  } while (pageToken);
  return users;
}
