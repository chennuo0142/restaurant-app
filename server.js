#!/usr/bin/env node
const express = require('express');
const http = require('http');

const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ================= SÉCURITÉ : CODE PIN ADMIN =================
const ADMIN_PIN = process.env.ADMIN_PIN || "123456";
console.log(`[SÉCURITÉ] Code PIN Admin actif : ${ADMIN_PIN}`);

// ================= BASE DE DONNÉES SQLITE =================
const db = new sqlite3.Database('./restaurant.db', (err) => {
    if (err) console.error("Erreur BDD :", err.message);
});

// Promisification manuelle des méthodes SQLite pour utiliser async/await
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

// Initialisation asynchrone de la base de données
async function initDB() {
    try {
        await dbRun(`
            CREATE TABLE IF NOT EXISTS restaurant_tables (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                number TEXT UNIQUE NOT NULL,
                capacity INTEGER NOT NULL,
                status TEXT DEFAULT 'libre'
            )
        `);
        await dbRun(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);

        const row = await dbGet("SELECT COUNT(*) as count FROM restaurant_tables");
        if (row && row.count === 0) {
            await dbRun("INSERT INTO restaurant_tables (number, capacity, status) VALUES (?, ?, ?)", ["101", 2, "libre"]);
            await dbRun("INSERT INTO restaurant_tables (number, capacity, status) VALUES (?, ?, ?)", ["102", 4, "occupee"]);
        }

        await dbRun("INSERT OR IGNORE INTO config (key, value) VALUES ('viewMode', 'grid')");
    } catch (err) {
        console.error("Erreur lors de l'initialisation de la BDD:", err);
    }
}

// Lancement de l'initialisation
initDB();

// Fonction de diffusion asynchrone
async function broadcastUpdate() {
    try {
        const tables = await dbAll("SELECT * FROM restaurant_tables");
        const configRow = await dbGet("SELECT value FROM config WHERE key = 'viewMode'");
        const viewMode = configRow ? configRow.value : 'grid';

        io.emit('updateTables', tables);
        io.emit('updateViewMode', viewMode);
    } catch (err) {
        console.error("Erreur lors du broadcast :", err.message);
    }
}

// ================= COMMUNICATIONS TEMPS RÉEL =================
io.on('connection', async (socket) => {

    // Envoi initial des données
    try {
        const tables = await dbAll("SELECT * FROM restaurant_tables");
        const configRow = await dbGet("SELECT value FROM config WHERE key = 'viewMode'");
        socket.emit('initData', { tables, viewMode: configRow ? configRow.value : 'grid' });
    } catch (err) {
        console.error("Erreur d'envoi initial :", err.message);
    }

    // VERIFICATION DU CODE PIN
    socket.on('verifyAdminPin', (pin, callback) => {
        if (pin === ADMIN_PIN) {
            callback({ success: true });
        } else {
            callback({ success: false, message: "Code PIN incorrect" });
        }
    });

    // ACTION SECURISEE : Ajouter une table
    socket.on('addTable', async ({ number, capacity, pin }, callback) => {
        if (pin !== ADMIN_PIN) {
            return callback ? callback({ success: false, message: "Code PIN requis ou invalide" }) : null;
        }

        try {
            await dbRun(`INSERT INTO restaurant_tables (number, capacity, status) VALUES (?, ?, 'libre')`, [number, parseInt(capacity)]);
            if (callback) callback({ success: true });
            await broadcastUpdate();
        } catch (err) {
            if (callback) callback({ success: false, message: "Ce numéro de table existe déjà." });
        }
    });

    // ACTION SECURISEE : Supprimer une table
    socket.on('deleteTable', async ({ tableId, pin }, callback) => {
        if (pin !== ADMIN_PIN) {
            return callback ? callback({ success: false, message: "Action non autorisée" }) : null;
        }

        try {
            await dbRun("DELETE FROM restaurant_tables WHERE id = ?", [tableId]);
            if (callback) callback({ success: true });
            await broadcastUpdate();
        } catch (err) {
            if (callback) callback({ success: false, message: "Erreur lors de la suppression" });
        }
    });

    // ACTION SECURISEE : Modifier une table
    socket.on('editTable', async ({ tableId, number, capacity, pin }, callback) => {
        if (pin !== ADMIN_PIN) {
            return callback ? callback({ success: false, message: "Action non autorisée" }) : null;
        }

        try {
            await dbRun(`UPDATE restaurant_tables SET number = ?, capacity = ? WHERE id = ?`, [number, parseInt(capacity), tableId]);
            if (callback) callback({ success: true });
            await broadcastUpdate();
        } catch (err) {
            if (callback) callback({ success: false, message: "Ce numéro de table est déjà utilisé." });
        }
    });

    // Action Admin : Changer le mode d'affichage
    socket.on('changeViewMode', async (mode) => {
        try {
            await dbRun("UPDATE config SET value = ? WHERE key = 'viewMode'", [mode]);
            io.emit('updateViewMode', mode);
        } catch (err) {
            console.error(err.message);
        }
    });

    // Action Accueil / Service
    socket.on('occupyTable', async (tableId) => {
        try {
            await dbRun("UPDATE restaurant_tables SET status = 'occupee' WHERE id = ?", [tableId]);
            await broadcastUpdate();
        } catch (err) {
            console.error(err.message);
        }
    });

    // Action Caisse : La table a payé, elle attend d'être nettoyée
    socket.on('cleanTable', async (tableId) => {
        try {
            await dbRun("UPDATE restaurant_tables SET status = 'a_nettoyer' WHERE id = ?", [tableId]);
            await broadcastUpdate();
        } catch (err) {
            console.error(err.message);
        }
    });

    socket.on('freeTable', async (tableId) => {
        try {
            await dbRun("UPDATE restaurant_tables SET status = 'libre' WHERE id = ?", [tableId]);
            await broadcastUpdate();
        } catch (err) {
            console.error(err.message);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur asynchrone en ligne sur le port ${PORT}`);
});