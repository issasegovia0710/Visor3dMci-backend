const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

/* ============================
   Helpers
============================ */

function slugify(str) {
  return (
    (str || "proyecto")
      .toString()
      .normalize("NFD")
      .replace(/[̀-\u036f]/g, "")
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

// servir archivos estáticos de los modelos
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
    modelUrl: sceneDoc.modelFile ? `/public/${folder}/${sceneDoc.modelFile}` : null,
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
   POST /api/projects
   Crea carpeta + modelo + scene.json
============================ */

app.post("/api/projects", upload.single("model"), (req, res) => {
  try {
    const { projectName, author, date, password, position, rotation } = req.body;

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

    // modelo.ext
    const originalExt = path.extname(req.file.originalname) || "";
    const modelFileName = "modelo" + originalExt;
    const finalModelPath = path.join(projectDir, modelFileName);
    fs.renameSync(req.file.path, finalModelPath);

    // posición / rotación
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
   Actualiza posición y rotación
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

    // si viene contraseña la validamos
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
   Reemplaza el modelo
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

    // borrar modelo anterior si existe
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
   Cambia solo el nombre del proyecto
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
    return res.json({ ok: true, project: view, message: "Proyecto renombrado." });
  } catch (err) {
    console.error("Error en PUT /api/projects/:id/rename:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* ============================
   PUT /api/projects/:id/notes
   Guarda notas generales del proyecto
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
   Guarda nombre, notas, color y material de una pieza
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

    const { partId, name, notes, color, materialPreset, password } = req.body || {};
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
        materialPreset !== undefined ? materialPreset : oldMeta.materialPreset || "plastic",
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
   Borra carpeta si contraseña coincide
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
   Arrancar servidor
============================ */

app.listen(PORT, () => {
  console.log(`API corriendo en puerto ${PORT}`);
});
