const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const XLSX = require("xlsx"); // Para generar el Excel en memoria

/* ============================
   Firebase Admin (backend)
============================ */
const admin = require("firebase-admin");

let db = null;
let bucket = null;

try {
  const projectId = process.env.FIREBASE_PROJECT_ID || "visor3dmci";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (clientEmail && privateKey) {
    // Si viene con \n escapados, los restauramos
    privateKey = privateKey.replace(/\\n/g, "\n");

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        storageBucket:
          process.env.FIREBASE_STORAGE_BUCKET ||
          "visor3dmci.firebasestorage.app",
      });
    }

    db = admin.firestore();
    bucket = admin.storage().bucket();

    console.log("✅ Firebase Admin inicializado correctamente.");
  } else {
    console.warn(
      "⚠️ Variables FIREBASE_CLIENT_EMAIL o FIREBASE_PRIVATE_KEY no definidas. Firebase no se inicializará."
    );
  }
} catch (err) {
  console.error("❌ Error inicializando Firebase Admin:", err);
}

/* ============================
   Helpers
============================ */

function slugify(str) {
  return (
    (str || "proyecto")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 40) || "proyecto"
  );
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/* ============================
   Configuración básica
============================ */

const app = express();
const PORT = process.env.PORT || 4000;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  })
);
app.use(express.json());

const publicDir = path.join(__dirname, "public");

// servir archivos estáticos
app.use("/public", express.static(publicDir));

// carpeta temporal para subidas
const uploadTmpDir = path.join(__dirname, "tmp_uploads");
if (!fs.existsSync(uploadTmpDir)) {
  fs.mkdirSync(uploadTmpDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadTmpDir);
  },
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName);
  },
});

const upload = multer({ storage });

/* ============================
   Utilidades para scene.json
============================ */

function ensurePublicDir() {
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
}

function readScene(folder) {
  ensurePublicDir();
  const dir = path.join(publicDir, folder);
  const scenePath = path.join(dir, "scene.json");
  if (!fs.existsSync(scenePath)) return null;
  const raw = fs.readFileSync(scenePath, "utf8");
  const sceneDoc = JSON.parse(raw);

  return {
    id: folder,
    name: sceneDoc.projectName || folder,
    author: sceneDoc.author || "",
    date: sceneDoc.date || "",
    position: sceneDoc.position || { x: 0, y: 0, z: 0 },
    rotation: sceneDoc.rotation || { x: 0, y: 0, z: 0 },
    passwordHash: sceneDoc.passwordHash || "",
    modelFile: sceneDoc.modelFile || null,
    modelUrl: sceneDoc.modelFile
      ? `/public/${folder}/${sceneDoc.modelFile}`
      : null,
    pendingNotes: sceneDoc.pendingNotes || "",
    partsMeta: sceneDoc.partsMeta || {},
    _raw: sceneDoc,
  };
}

function writeScene(folder, sceneDoc) {
  ensurePublicDir();
  const dir = path.join(publicDir, folder);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const scenePath = path.join(dir, "scene.json");
  fs.writeFileSync(scenePath, JSON.stringify(sceneDoc, null, 2), "utf8");
}

/* ============================
   Helper: armar workbook de Excel en memoria
   (SIN columna de links)
============================ */

function buildQuoteWorkbook(quoteDoc) {
  const rows = (quoteDoc.items || []).map((it) => ({
    Concepto: it.concepto,
    Cantidad: it.cantidad,
    Precio: it.precio,
    Importe: it.cantidad * it.precio,
  }));

  rows.push({});
  rows.push({
    Concepto: "TOTAL",
    Cantidad: "",
    Precio: "",
    Importe: quoteDoc.total,
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["Concepto", "Cantidad", "Precio", "Importe"],
  });

  XLSX.utils.book_append_sheet(wb, ws, "Cotización");
  return wb;
}

/* ============================
   POST /api/projects
   Crea carpeta + modelo + scene.json
============================ */

app.post("/api/projects", upload.single("model"), (req, res) => {
  try {
    const { projectName, author, date, password, position, rotation } =
      req.body;

    if (!projectName || !password || !req.file) {
      return res.status(400).json({
        ok: false,
        error: "projectName, password y model son obligatorios.",
      });
    }

    const folderSlug = slugify(projectName);
    ensurePublicDir();
    const projectDir = path.join(publicDir, folderSlug);
    fs.mkdirSync(projectDir, { recursive: true });

    const originalExt = path.extname(req.file.originalname) || "";
    const modelFileName = "modelo" + originalExt;
    const finalModelPath = path.join(projectDir, modelFileName);
    fs.renameSync(req.file.path, finalModelPath);

    let positionObj = { x: 0, y: 0, z: 0 };
    let rotationObj = { x: 0, y: 0, z: 0 };

    try {
      if (position) positionObj = JSON.parse(position);
    } catch (e) {
      console.warn("position no es JSON válido, se usa por defecto.");
    }

    try {
      if (rotation) rotationObj = JSON.parse(rotation);
    } catch (e) {
      console.warn("rotation no es JSON válido, se usa por defecto.");
    }

    const sceneDoc = {
      projectName,
      author: author || "",
      date: date || new Date().toISOString().slice(0, 10),
      passwordHash: hashPassword(password),
      position: positionObj,
      rotation: rotationObj,
      modelFile: modelFileName,
      pendingNotes: "",
      partsMeta: {},
    };

    writeScene(folderSlug, sceneDoc);

    return res.status(201).json({
      ok: true,
      message: "Proyecto creado.",
      projectId: folderSlug,
      projectFolder: `public/${folderSlug}`,
      modelFile: modelFileName,
      sceneFile: "scene.json",
    });
  } catch (err) {
    console.error("Error en POST /api/projects:", err);
    return res.status(500).json({
      ok: false,
      error: "Error interno del servidor.",
    });
  }
});

/* ============================
   GET /api/projects
   Lista todos los proyectos
============================ */

app.get("/api/projects", (req, res) => {
  try {
    ensurePublicDir();
    const dirs = fs
      .readdirSync(publicDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const projects = [];
    for (const d of dirs) {
      const scene = readScene(d.name);
      if (scene) {
        const { _raw, passwordHash, ...view } = scene;
        projects.push(view);
      }
    }

    return res.json({ ok: true, projects });
  } catch (err) {
    console.error("Error en GET /api/projects:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   GET /api/projects/:id
   Devuelve datos de un proyecto
============================ */

app.get("/api/projects/:id", (req, res) => {
  try {
    const scene = readScene(req.params.id);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    const { _raw, passwordHash, ...view } = scene;
    return res.json({ ok: true, project: view });
  } catch (err) {
    console.error("Error en GET /api/projects/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   PUT /api/projects/:id/transform
============================ */

app.put("/api/projects/:id/transform", (req, res) => {
  try {
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }

    if (req.body.password) {
      const hash = hashPassword(req.body.password);
      if (hash !== scene.passwordHash) {
        return res
          .status(403)
          .json({ ok: false, error: "Contraseña incorrecta." });
      }
    }

    const scenePath = path.join(publicDir, folder, "scene.json");
    const sceneDoc = JSON.parse(fs.readFileSync(scenePath, "utf8"));

    const position = req.body.position || scene.position;
    const rotation = req.body.rotation || scene.rotation;

    sceneDoc.position = position;
    sceneDoc.rotation = rotation;

    writeScene(folder, sceneDoc);

    const updated = readScene(folder);
    const { _raw, passwordHash, ...view } = updated;
    return res.json({ ok: true, project: view });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/transform:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   PUT /api/projects/:id/model
============================ */

app.put("/api/projects/:id/model", upload.single("model"), (req, res) => {
  try {
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }
    if (!req.file) {
      return res
        .status(400)
        .json({ ok: false, error: "Archivo de modelo requerido." });
    }

    const dir = path.join(publicDir, folder);

    if (scene.modelFile) {
      const oldPath = path.join(dir, scene.modelFile);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    const ext = path.extname(req.file.originalname) || "";
    const modelFileName = "modelo" + ext;
    const finalModelPath = path.join(dir, modelFileName);
    fs.renameSync(req.file.path, finalModelPath);

    const scenePath = path.join(dir, "scene.json");
    const sceneDoc = JSON.parse(fs.readFileSync(scenePath, "utf8"));
    sceneDoc.modelFile = modelFileName;
    writeScene(folder, sceneDoc);

    const updated = readScene(folder);
    const { _raw, passwordHash, ...view } = updated;
    return res.json({
      ok: true,
      project: view,
      message: "Modelo reemplazado.",
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/model:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   PUT /api/projects/:id/rename
============================ */

app.put("/api/projects/:id/rename", (req, res) => {
  try {
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }

    const { name, password } = req.body || {};
    if (!name || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "name y password son obligatorios." });
    }

    const hash = hashPassword(password);
    if (hash !== scene.passwordHash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const scenePath = path.join(publicDir, folder, "scene.json");
    const sceneDoc = JSON.parse(fs.readFileSync(scenePath, "utf8"));
    sceneDoc.projectName = name;
    writeScene(folder, sceneDoc);

    const updated = readScene(folder);
    const { _raw, passwordHash, ...view } = updated;
    return res.json({
      ok: true,
      project: view,
      message: "Proyecto renombrado.",
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/rename:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   PUT /api/projects/:id/notes
============================ */

app.put("/api/projects/:id/notes", (req, res) => {
  try {
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }

    const { notes, password } = req.body || {};
    if (typeof notes !== "string" || !password) {
      return res.status(400).json({
        ok: false,
        error: "notes (string) y password son obligatorios.",
      });
    }

    const hash = hashPassword(password);
    if (hash !== scene.passwordHash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const scenePath = path.join(publicDir, folder, "scene.json");
    const sceneDoc = JSON.parse(fs.readFileSync(scenePath, "utf8"));
    sceneDoc.pendingNotes = notes;
    writeScene(folder, sceneDoc);

    const updated = readScene(folder);
    const { _raw, passwordHash, ...view } = updated;
    return res.json({ ok: true, project: view, message: "Notas guardadas." });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/notes:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   PUT /api/projects/:id/parts-meta
============================ */

app.put("/api/projects/:id/parts-meta", (req, res) => {
  try {
    console.log("PUT /api/projects/:id/parts-meta llamado");
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }

    const { partId, name, notes, color, materialPreset, password } =
      req.body || {};
    if (partId === undefined || !password) {
      return res.status(400).json({
        ok: false,
        error: "partId y password son obligatorios.",
      });
    }

    const hash = hashPassword(password);
    if (hash !== scene.passwordHash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const scenePath = path.join(publicDir, folder, "scene.json");
    const sceneDoc = JSON.parse(fs.readFileSync(scenePath, "utf8"));

    if (!sceneDoc.partsMeta) sceneDoc.partsMeta = {};

    const key = String(partId);
    const oldMeta = sceneDoc.partsMeta[key] || {};

    sceneDoc.partsMeta[key] = {
      name: name !== undefined ? name : oldMeta.name || "",
      notes: notes !== undefined ? notes : oldMeta.notes || "",
      color: color !== undefined ? color : oldMeta.color || "#22c55e",
      materialPreset:
        materialPreset !== undefined
          ? materialPreset
          : oldMeta.materialPreset || "plastic",
    };

    writeScene(folder, sceneDoc);

    const updated = readScene(folder);
    const { _raw, passwordHash, ...view } = updated;
    return res.json({
      ok: true,
      project: view,
      message: "Metadatos de pieza guardados.",
    });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/parts-meta:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   DELETE /api/projects/:id
============================ */

app.delete("/api/projects/:id", (req, res) => {
  try {
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }

    const { password } = req.body || {};
    if (!password) {
      return res
        .status(400)
        .json({ ok: false, error: "Contraseña requerida." });
    }

    const hash = hashPassword(password);
    if (hash !== scene.passwordHash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const projectDir = path.join(publicDir, folder);
    fs.rmSync(projectDir, { recursive: true, force: true });

    return res.json({ ok: true, message: "Proyecto eliminado." });
  } catch (err) {
    console.error("Error en DELETE /api/projects/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   COTIZACIONES
   /api/quotes/:id
============================ */

/* GET /api/quotes/:id  -> lee cotizacion.json */
app.get("/api/quotes/:id", (req, res) => {
  try {
    const folder = req.params.id;
    const dir = path.join(publicDir, folder);
    const quotePath = path.join(dir, "cotizacion.json");

    if (!fs.existsSync(quotePath)) {
      return res.status(404).json({
        ok: false,
        error: "No hay cotización guardada para este proyecto.",
      });
    }

    const raw = fs.readFileSync(quotePath, "utf8");
    const quoteDoc = JSON.parse(raw);

    return res.json({
      ok: true,
      quote: quoteDoc,
    });
  } catch (err) {
    console.error("Error en GET /api/quotes/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* PUT /api/quotes/:id
   Guarda cotizacion.json
   (EL EXCEL NO SE GUARDA, SOLO SE GENERA AL DESCARGAR)
*/
app.put("/api/quotes/:id", (req, res) => {
  try {
    const folder = req.params.id;
    const scene = readScene(folder);
    if (!scene) {
      return res
        .status(404)
        .json({ ok: false, error: "Proyecto no encontrado." });
    }

    const { password, items, total } = req.body || {};

    if (!password || !Array.isArray(items)) {
      return res.status(400).json({
        ok: false,
        error: "password e items (array) son obligatorios.",
      });
    }

    const hash = hashPassword(password);
    if (hash !== scene.passwordHash) {
      return res
        .status(403)
        .json({ ok: false, error: "Contraseña incorrecta." });
    }

    const normalizedItems = items.map((it) => ({
      concepto: (it.concepto || "").toString(),
      cantidad: Number(it.cantidad) || 0,
      precio: Number(it.precio) || 0,
      link: (it.link || "").toString(),
    }));

    let computedTotal = normalizedItems.reduce(
      (acc, it) => acc + it.cantidad * it.precio,
      0
    );
    if (!isFinite(computedTotal)) computedTotal = 0;

    const quoteDoc = {
      projectId: folder,
      projectName: scene.name,
      date: new Date().toISOString(),
      items: normalizedItems,
      total: typeof total === "number" ? total : computedTotal,
    };

    const dir = path.join(publicDir, folder);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const quotePath = path.join(dir, "cotizacion.json");
    fs.writeFileSync(quotePath, JSON.stringify(quoteDoc, null, 2), "utf8");

    return res.json({
      ok: true,
      message: "Cotización guardada.",
      quote: quoteDoc,
    });
  } catch (err) {
    console.error("Error en PUT /api/quotes/:id:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* GET /api/quotes/:id/excel
   Genera el Excel EN MEMORIA y lo descarga
   (NO se guarda cotizacion.xlsx en disco)
*/
app.get("/api/quotes/:id/excel", (req, res) => {
  try {
    const folder = req.params.id;
    const quotePath = path.join(publicDir, folder, "cotizacion.json");

    if (!fs.existsSync(quotePath)) {
      return res.status(404).json({
        ok: false,
        error:
          "No hay cotización guardada. Primero guarda la cotización para poder descargar el Excel.",
      });
    }

    const raw = fs.readFileSync(quotePath, "utf8");
    const quoteDoc = JSON.parse(raw);

    const wb = buildQuoteWorkbook(quoteDoc);

    const buffer = XLSX.write(wb, {
      bookType: "xlsx",
      type: "buffer",
    });

    const fileName = `cotizacion-${folder}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    return res.send(buffer);
  } catch (err) {
    console.error("Error en GET /api/quotes/:id/excel:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   TEST: Firebase
============================ */

app.get("/api/fb-test", async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        ok: false,
        error:
          "Firebase no está inicializado. Revisa las variables FIREBASE_* en el servidor.",
      });
    }

    const now = new Date().toISOString();

    await db.collection("tests").doc("visor3dmci-test").set({
      message: "Hola desde backend Node",
      at: now,
    });

    const snap = await db.collection("tests").doc("visor3dmci-test").get();

    return res.json({
      ok: true,
      fromFirestore: snap.exists ? snap.data() : null,
    });
  } catch (err) {
    console.error("Error en /api/fb-test:", err);
    return res.status(500).json({ ok: false, error: "Firebase no respondió." });
  }
});

/* ============================
   Arrancar servidor
============================ */

app.listen(PORT, () => {
  console.log(`API corriendo en puerto ${PORT}`);
});
