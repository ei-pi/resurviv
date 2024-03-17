import { type WebSocket } from "uWebSockets.js";
import { type PlayerContainer } from "./server";
import { Player } from "./objects/player";
import { type Vec2, v2 } from "../../shared/utils/v2";
import { Grid } from "./utils/grid";
import { ObjectType, type BaseGameObject } from "./objects/gameObject";
import { SpawnMode, type ConfigType } from "./config";
import { GameMap } from "./map";
import { BulletManager } from "./objects/bullet";
import { Logger } from "./utils/logger";
import { Loot } from "./objects/loot";
import { GameObjectDefs } from "../../shared/defs/gameObjectDefs";
import { GameConfig } from "../../shared/gameConfig";
import net from "../../shared/net";
import { type Explosion } from "./objects/explosion";
import { type Msg } from "../../shared/netTypings";
import { EmotesDefs } from "../../shared/defs/gameObjects/emoteDefs";
import { type GunDef, type AmmoDef, type BoostDef, type ChestDef, type HealDef, type HelmetDef, type ScopeDef, type ThrowableDef, type MeleeDef } from "../../shared/defs/objectsTypings";

export class Emote {
    playerId: number;
    pos: Vec2;
    type: string;
    isPing: boolean;

    constructor(playerId: number, pos: Vec2, type: string, isPing: boolean) {
        this.playerId = playerId;
        this.pos = pos;
        this.type = type;
        this.isPing = isPing;
    }
}
export class Game {
    stopped = false;
    allowJoin = true;
    over = false;
    startedTime = 0;

    nextObjId = 0;

    nextGroupId = 0;

    players = new Set<Player>();
    connectedPlayers = new Set<Player>();
    livingPlayers = new Set<Player>();

    get aliveCount(): number {
        return this.livingPlayers.size;
    }

    aliveCountDirty = false;

    msgsToSend: Array<{ type: number, msg: Msg }> = [];

    partialObjs = new Set<BaseGameObject>();
    fullObjs = new Set<BaseGameObject>();

    newPlayers: Player[] = [];

    explosions: Explosion[] = [];

    id: number;

    map: GameMap;

    grid: Grid;

    tickInterval: NodeJS.Timeout;

    /**
     * for stuff based on ms
     */
    realDt: number;
    /**
     * realDt divided by 1000, used for physics since speed values are in unit/second.
     * for stuff based on seconds
     */
    dt: number;

    config: ConfigType;

    now = Date.now();

    tickTimes: number[] = [];

    bulletManager = new BulletManager(this);

    // serializationCache = new SerializationCache();

    logger: Logger;

    emotes = new Set<Emote>();

    constructor(id: number, config: ConfigType) {
        this.id = id;
        this.logger = new Logger(`Game #${this.id}`);
        this.logger.log("Creating");
        const start = Date.now();

        this.config = config;

        this.grid = new Grid(1024, 1024);
        this.map = new GameMap(this);

        this.realDt = 1000 / config.tps;
        this.dt = this.realDt / 1000;
        this.tickInterval = setInterval(() => this.tick(), this.realDt);
        this.allowJoin = true;

        this.logger.log(`Created in ${Date.now() - start} ms`);
    }

    tick(): void {
        this.now = Date.now();

        this.bulletManager.update();

        for (const loot of this.grid.categories[ObjectType.Loot]) {
            loot.update();
        }

        for (const explosion of this.explosions) {
            explosion.explode(this);
        }

        for (const player of this.players) {
            player.update();
        }

        // this.serializationCache.update(this);

        for (const player of this.connectedPlayers) {
            if (this.emotes.size) {
                for (const emote of this.emotes) {
                    if (emote.playerId === player.id || !emote.isPing) {
                        player.emotes.add(emote);
                    }
                }
            }

            player.sendMsgs();
        }

        //
        // reset stuff
        //
        for (const player of this.players) {
            for (const key in player.dirty) {
                player.dirty[key as keyof Player["dirty"]] = false;
            }
        }

        this.fullObjs.clear();
        this.partialObjs.clear();
        this.newPlayers.length = 0;
        this.bulletManager.reset();
        this.msgsToSend.length = 0;
        this.explosions.length = 0;
        this.aliveCountDirty = false;

        this.emotes.clear();

        // Record performance and start the next tick
        // THIS TICK COUNTER IS WORKING CORRECTLY!
        // It measures the time it takes to calculate a tick, not the time between ticks.
        const tickTime = Date.now() - this.now;
        this.tickTimes.push(tickTime);

        if (this.tickTimes.length >= 200) {
            const mspt = this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length;

            this.logger.log(`Avg ms/tick: ${mspt.toFixed(2)} | Load: ${((mspt / this.realDt) * 100).toFixed(1)}%`);
            this.tickTimes = [];
        }
    }

    addPlayer(socket: WebSocket<PlayerContainer>): Player {
        let position: Vec2;

        switch (this.config.spawn.mode) {
        case SpawnMode.Center:
            position = v2.create(this.map.width / 2, this.map.height / 2);
            break;
        case SpawnMode.Fixed:
            position = v2.copy(this.config.spawn.position);
            break;
        case SpawnMode.Random:
            position = this.map.getRandomSpawnPosition();
            break;
        }

        const player = new Player(
            this,
            position,
            socket);

        return player;
    }

    /**
     * spawns gun loot without ammo attached, use addLoot() if you want the respective ammo to drop alongside the gun
     */
    addGun(type: string, pos: Vec2, layer: number, count: number) {
        const loot = new Loot(this, type, pos, layer, count);
        this.grid.addObject(loot);
    }

    addLoot(type: string, pos: Vec2, layer: number, count: number, useCountForAmmo?: boolean) {
        const loot = new Loot(this, type, pos, layer, count);
        this.grid.addObject(loot);

        const def = GameObjectDefs[type];

        if (def.type === "gun" && GameObjectDefs[def.ammo]) {
            const ammoCount = useCountForAmmo ? count : def.ammoSpawnCount;
            const halfAmmo = Math.ceil(ammoCount / 2);

            const leftAmmo = new Loot(this, def.ammo, v2.add(pos, v2.create(-0.2, -0.2)), layer, halfAmmo, 0);
            leftAmmo.push(v2.create(-1, -1), 0.5);
            this.grid.addObject(leftAmmo);

            if (ammoCount - halfAmmo >= 1) {
                const rightAmmo = new Loot(this, def.ammo, v2.add(pos, v2.create(0.2, -0.2)), layer, ammoCount - halfAmmo, 0);
                rightAmmo.push(v2.create(1, -1), 0.5);

                this.grid.addObject(rightAmmo);
            }
        }
    }

    handleMsg(buff: ArrayBuffer, player: Player): void {
        const msgStream = new net.MsgStream(buff);
        const type = msgStream.deserializeMsgType();
        const stream = msgStream.stream!;
        switch (type) {
        case net.MsgType.Input: {
            const inputMsg = new net.InputMsg();
            inputMsg.deserialize(stream);
            player.handleInput(inputMsg);
            break;
        }
        case net.MsgType.Join: {
            const joinMsg = new net.JoinMsg();
            joinMsg.deserialize(stream);

            if (joinMsg.protocol !== GameConfig.protocolVersion) {
                const disconnectMsg = new net.DisconnectMsg();
                disconnectMsg.reason = "index-invalid-protocol";
                player.sendMsg(net.MsgType.Disconnect, disconnectMsg);
                setTimeout(() => {
                    player.socket.close();
                }, 1);
                return;
            }

            let name = joinMsg.name;
            if (name.trim() === "") name = "Player";
            player.name = name;
            player.joinedTime = Date.now();

            player.isMobile = joinMsg.isMobile;

            const emotes = joinMsg.emotes;
            for (let i = 0; i < emotes.length; i++) {
                const emote = emotes[i];
                if ((i < 4 && emote === "")) {
                    player.loadout.emotes.push("emote_logoswine");
                    continue;
                }

                if (EmotesDefs[emote as keyof typeof EmotesDefs] === undefined &&
                    emote != "") {
                    player.loadout.emotes.push("emote_logoswine");
                } else player.loadout.emotes.push(emote);
            }

            this.newPlayers.push(player);
            this.grid.addObject(player);
            this.connectedPlayers.add(player);
            this.players.add(player);
            this.livingPlayers.add(player);
            this.aliveCountDirty = true;
            break;
        }
        case net.MsgType.Emote: {
            const emoteMsg = new net.EmoteMsg();
            emoteMsg.deserialize(stream);

            this.emotes.add(new Emote(player.id, emoteMsg.pos, emoteMsg.type, emoteMsg.isPing));
            break;
        }
        case net.MsgType.DropItem: {
            const dropMsg = new net.DropItemMsg();
            dropMsg.deserialize(stream);

            // @TODO: move me somewhere
            const item = GameObjectDefs[dropMsg.item] as ScopeDef | HelmetDef | ChestDef | HealDef | BoostDef | AmmoDef | GunDef | ThrowableDef | MeleeDef;
            switch (item.type) {
            case "ammo": {
                const inventoryCount = player.inventory[dropMsg.item];

                if (inventoryCount === 0) return;

                let amountToDrop = Math.max(1, Math.floor(inventoryCount / 2));

                if (item.minStackSize && inventoryCount <= item.minStackSize) {
                    amountToDrop = Math.min(item.minStackSize, inventoryCount);
                } else if (inventoryCount <= 5) {
                    amountToDrop = Math.min(5, inventoryCount);
                }

                splitUpLoot(this, player, dropMsg.item, amountToDrop);
                player.inventory[dropMsg.item] -= amountToDrop;
                player.dirty.inventory = true;
                break;
            }
            case "scope": {
                const level = item.level;
                if (level === 1) break;

                const availableScopeLevels = [15, 8, 4, 2, 1];
                let targetScopeLevel = availableScopeLevels.indexOf(level);

                this.addLoot(dropMsg.item, player.pos, player.layer, 1);
                player.inventory[`${level}xscope`] = 0;

                for (let i = 0; i < availableScopeLevels.length; i++) {
                    if (player.inventory[`${availableScopeLevels[i]}xscope`]) {
                        targetScopeLevel = availableScopeLevels[i];
                        break;
                    }
                }

                player.scope = `${targetScopeLevel}xscope`;
                break;
            }
            case "chest":
            case "helmet": {
                if (item.noDrop) break;
                this.addLoot(dropMsg.item, player.pos, player.layer, 1);
                player[item.type] = "";
                player.setDirty();
                break;
            }
            case "heal":
            case "boost": {
                if (player.inventory[dropMsg.item] === 0) break;
                player.inventory[dropMsg.item]--;
                // @TODO: drop more than one?
                this.addLoot(dropMsg.item, player.pos, player.layer, 1);
                player.dirty.inventory = true;
                break;
            }
            case "gun": {
                const weaponAmmoType = (GameObjectDefs[player.weapons[dropMsg.weapIdx].type] as GunDef).ammo;
                const weaponAmmoCount = player.weapons[dropMsg.weapIdx].ammo;

                player.weapons[dropMsg.weapIdx].type = "";
                player.weapons[dropMsg.weapIdx].ammo = 0;
                if (player.curWeapIdx == dropMsg.weapIdx) {
                    player.curWeapIdx = 2;
                }

                const backpackLevel = Number(player.backpack.at(-1));// backpack00, backpack01, etc ------- at(-1) => 0, 1, etc
                const bagSpace = GameConfig.bagSizes[weaponAmmoType][backpackLevel];
                if (player.inventory[weaponAmmoType] + weaponAmmoCount <= bagSpace) {
                    player.inventory[weaponAmmoType] += weaponAmmoCount;
                    player.dirty.inventory = true;
                } else {
                    const spaceLeft = bagSpace - player.inventory[weaponAmmoType];
                    const amountToAdd = spaceLeft;

                    player.inventory[weaponAmmoType] += amountToAdd;
                    player.dirty.inventory = true;

                    const amountToDrop = weaponAmmoCount - amountToAdd;

                    this.addLoot(weaponAmmoType, player.pos, player.layer, amountToDrop);
                }

                this.addGun(dropMsg.item, player.pos, player.layer, 1);
                player.dirty.weapons = true;
                player.setDirty();
                break;
            }
            case "throwable": {
                const inventoryCount = player.inventory[dropMsg.item];

                if (inventoryCount === 0) return;

                const amountToDrop = Math.max(1, Math.floor(inventoryCount / 2));

                splitUpLoot(this, player, dropMsg.item, amountToDrop);
                player.inventory[dropMsg.item] -= amountToDrop;
                player.weapons[3].ammo -= amountToDrop;

                if (player.inventory[dropMsg.item] == 0) {
                    player.showNextThrowable();
                }
                player.dirty.inventory = true;
                player.dirty.weapons = true;
                break;
            }
            case "melee": {
                if (player.weapons[2].type != "fists") {
                    this.addLoot(dropMsg.item, player.pos, player.layer, 1);
                    player.weapons[2].type = "fists";
                    player.weapons[2].ammo = 0;
                    player.dirty.weapons = true;
                    player.setDirty();
                }
            }
            }

            player.cancelAction();
        }
        }
    }

    removePlayer(player: Player): void {
        this.connectedPlayers.delete(player);
    }

    end(): void {
        this.stopped = true;
        this.allowJoin = false;
        clearInterval(this.tickInterval);
        for (const player of this.players) {
            player.socket.close();
        }
        this.logger.log("Game Ended");
    }
}

function splitUpLoot(game: Game, player: Player, item: string, amount: number) {
    const dropCount = Math.floor(amount / 60);
    for (let i = 0; i < dropCount; i++) {
        game.addLoot(item, player.pos, player.layer, 60);
    }
    if (amount % 60 !== 0) game.addLoot(item, player.pos, player.layer, amount % 60);
}
