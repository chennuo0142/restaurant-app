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
// Par défaut: 123456. Modifiable au lancement (ex: ADMIN_PIN=987654 node server.js)
const ADMIN_PIN = process.env.ADMIN_PIN || "123456";
console.log(`[SÉCURITÉ] Code PIN Admin actif : ${ADMIN_PIN}`);

// ================= BASE DE DONNÉES SQLITE =================
const db = new sqlite3.Database('./restaurant.db', (err) => {
    if (err) console.error("Erreur BDD :", err.message);
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS restaurant_tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT UNIQUE NOT NULL,
            capacity INTEGER NOT NULL,
            status TEXT DEFAULT 'libre'
        )
    `);
    db.run(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);

    db.get("SELECT COUNT(*) as count FROM restaurant_tables", [], (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO restaurant_tables (number, capacity, status) VALUES (?, ?, ?)");
            stmt.run("101", 2, "libre");
            stmt.run("102", 4, "occupee");
            stmt.finalize();
        }
    });
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('viewMode', 'grid')");
});

function broadcastUpdate() {
    db.all("SELECT * FROM restaurant_tables", [], (err, tables) => {
        if (err) return console.error(err.message);
        db.get("SELECT value FROM config WHERE key = 'viewMode'", [], (err, configRow) => {
            const viewMode = configRow ? configRow.value : 'grid';
            io.emit('updateTables', tables);
            io.emit('updateViewMode', viewMode);
        });
    });
}

// ================= COMMUNICATIONS TEMPS RÉEL =================
io.on('connection', (socket) => {

    // Envoi initial des données
    db.all("SELECT * FROM restaurant_tables", [], (err, tables) => {
        db.get("SELECT value FROM config WHERE key = 'viewMode'", [], (err, configRow) => {
            socket.emit('initData', { tables, viewMode: configRow ? configRow.value : 'grid' });
        });
    });

    // VERIFICATION DU CODE PIN (Demande d'initialisation de l'écran admin)
    socket.on('verifyAdminPin', (pin, callback) => {
        if (pin === ADMIN_PIN) {
            callback({ success: true });
        } else {
            callback({ success: false, message: "Code PIN incorrect" });
        }
    });

    // ACTION SECURISEE : Ajouter une table
    socket.on('addTable', ({ number, capacity, pin }, callback) => {
        if (pin !== ADMIN_PIN) {
            return callback ? callback({ success: false, message: "Code PIN requis ou invalide" }) : null;
        }

        const query = `INSERT INTO restaurant_tables (number, capacity, status) VALUES (?, ?, 'libre')`;
        db.run(query, [number, parseInt(capacity)], function (err) {
            if (err) {
                return callback ? callback({ success: false, message: "Ce numéro de table existe déjà." }) : null;
            }
            if (callback) callback({ success: true });
            broadcastUpdate();
        });
    });

    // ACTION SECURISEE : Supprimer une table
    socket.on('deleteTable', ({ tableId, pin }, callback) => {
        if (pin !== ADMIN_PIN) {
            return callback ? callback({ success: false, message: "Action non autorisée" }) : null;
        }

        db.run("DELETE FROM restaurant_tables WHERE id = ?", [tableId], function (err) {
            if (err) {
                return callback ? callback({ success: false, message: "Erreur lors de la suppression" }) : null;
            }
            if (callback) callback({ success: true });
            broadcastUpdate();
        });
    });

    // ACTION SECURISEE : Modifier une table
    socket.on('editTable', ({ tableId, number, capacity, pin }, callback) => {
        if (pin !== ADMIN_PIN) {
            return callback ? callback({ success: false, message: "Action non autorisée" }) : null;
        }

        const query = `UPDATE restaurant_tables SET number = ?, capacity = ? WHERE id = ?`;
        db.run(query, [number, parseInt(capacity), tableId], function (err) {
            if (err) {
                return callback ? callback({ success: false, message: "Ce numéro de table est déjà utilisé." }) : null;
            }
            if (callback) callback({ success: true });
            broadcastUpdate();
        });
    });

    // Action Admin : Changer le mode d'affichage
    socket.on('changeViewMode', (mode) => {
        db.run("UPDATE config SET value = ? WHERE key = 'viewMode'", [mode], () => {
            io.emit('updateViewMode', mode);
        });
    });

    // Action Accueil / Service (Reste inchangé)
    socket.on('occupyTable', (tableId) => {
        db.run("UPDATE restaurant_tables SET status = 'occupee' WHERE id = ?", [tableId], () => broadcastUpdate());
    });

    // Action Caisse : La table a payé, elle attend d'être nettoyée
    socket.on('cleanTable', (tableId) => {
        db.run("UPDATE restaurant_tables SET status = 'a_nettoyer' WHERE id = ?", [tableId], () => broadcastUpdate());
    });

    socket.on('freeTable', (tableId) => {
        db.run("UPDATE restaurant_tables SET status = 'libre' WHERE id = ?", [tableId], () => broadcastUpdate());
    });
});

// const PORT = 3000;
// server.listen(PORT, '0.0.0.0', () => {
//     console.log(`Serveur sécurisé actif sur le port ${PORT}`);
// });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en ligne en production sur le port ${PORT}`);
});