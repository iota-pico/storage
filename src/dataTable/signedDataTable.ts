import { PlatformCryptoFactory } from "@iota-pico/core/dist/factories/platformCryptoFactory";
import { RngServiceFactory } from "@iota-pico/core/dist/factories/rngServiceFactory";
import { ArrayHelper } from "@iota-pico/core/dist/helpers/arrayHelper";
import { JsonHelper } from "@iota-pico/core/dist/helpers/jsonHelper";
import { NumberHelper } from "@iota-pico/core/dist/helpers/numberHelper";
import { ObjectHelper } from "@iota-pico/core/dist/helpers/objectHelper";
import { StringHelper } from "@iota-pico/core/dist/helpers/stringHelper";
import { ILogger } from "@iota-pico/core/dist/interfaces/ILogger";
import { NullLogger } from "@iota-pico/core/dist/loggers/nullLogger";
import { ObjectTrytesConverter } from "@iota-pico/data/dist/converters/objectTrytesConverter";
import { Address } from "@iota-pico/data/dist/data/address";
import { Hash } from "@iota-pico/data/dist/data/hash";
import { Tag } from "@iota-pico/data/dist/data/tag";
import { Trytes } from "@iota-pico/data/dist/data/trytes";
import { StorageError } from "../error/storageError";
import { DataTableIndex } from "../interfaces/dataTableIndex";
import { IDataTable } from "../interfaces/IDataTable";
import { IDataTableConfig } from "../interfaces/IDataTableConfig";
import { IDataTableConfigProvider } from "../interfaces/IDataTableConfigProvider";
import { IDataTableProgress } from "../interfaces/IDataTableProgress";
import { ISignedItem } from "../interfaces/ISignedItem";
import { IStorageClient } from "../interfaces/IStorageClient";

/**
 * Represents a table for storing data with signing.
 */
export class SignedDataTable<T> implements IDataTable<T> {
    /* @internal */
    private static readonly INDEX_TAG: Tag = Tag.fromTrytes(Trytes.fromString("INDEX"));

    /* @internal */
    private static readonly TIMESTAMP_TTL: number = 1000 * 60;

    /* @internal */
    private readonly _storageClient: IStorageClient;

    /* @internal */
    private readonly _configProvider: IDataTableConfigProvider;

    /* @internal */
    private readonly _tableName: string;

    /* @internal */
    private _config: IDataTableConfig;

    /* @internal */
    private readonly _publicKey: string;

    /* @internal */
    private readonly _privateKey: string;

    /* @internal */
    private readonly _logger: ILogger;

    /* @internal */
    private _progressCallback: (progress: IDataTableProgress) => void;

    /**
     * Create a new instance of the DataTable.
     * @param storageClient A storage client to perform storage operations.
     * @param configProvider A provider to get the configuration for the table.
     * @param tableName The name of the table.
     * @param publicKey The public key to use for platform crypto functions.
     * @param privateKey The private key to use for platform crypto functions.
     * @param logger Logger to send storage info to.
     */
    constructor(storageClient: IStorageClient,
                configProvider: IDataTableConfigProvider,
                tableName: string,
                publicKey: string,
                privateKey: string,
                logger?: ILogger) {
        this._storageClient = storageClient;
        this._configProvider = configProvider;
        this._tableName = tableName;
        this._publicKey = publicKey;
        this._privateKey = privateKey;
        this._logger = logger || new NullLogger();
    }

    /**
     * Get the index for the table.
     * @returns The table index.
     */
    public async index(): Promise<DataTableIndex> {
        this._logger.info("===> SignedDataTable::index");

        await this.loadConfig();

        let dataTableIndex;
        if (!StringHelper.isEmpty(this._config.indexBundleHash)) {
            const indexBundleHash = Hash.fromTrytes(Trytes.fromString(this._config.indexBundleHash));
            this.updateProgress(0, 1, "Retrieving Index");
            const index = await this._storageClient.load([indexBundleHash]);
            this.updateProgress(1, 1, "Retrieving Index");

            if (index && index.length > 0) {
                const objectToTrytesConverter = new ObjectTrytesConverter<ISignedItem<DataTableIndex>>();

                const signedItem = objectToTrytesConverter.from(index[0].data);

                if (!this.validateSignedItem(signedItem, index[0].attachmentTimestamp)) {
                    this._logger.info("<=== SignedDataTable::index invalid signature");
                    throw new StorageError("Item signature was not valid", indexBundleHash);
                } else {
                    dataTableIndex = signedItem.data;
                    this._logger.info("<=== SignedDataTable::index", signedItem);
                }
            } else {
                this._logger.info("<=== SignedDataTable::index no index available");
            }
        } else {
            this._logger.info("<=== SignedDataTable::index no index hash specified");
        }

        return dataTableIndex;
    }

    /**
     * Clear the index for the table.
     */
    public async clearIndex(): Promise<void> {
        this._logger.info("===> DataTable::clearIndex");

        await this.loadConfig();

        await this.saveIndex([]);
    }

    /**
     * Store an item of data in the table.
     * @param data The data to store.
     * @param tag The tag to store with the item.
     * @returns The id of the stored item.
     */
    public async store(data: T, tag: Tag = Tag.EMPTY): Promise<Hash> {
        this._logger.info("===> SignedDataTable::store", data, tag);

        const signedItem = this.createSignedItem(data);

        const objectToTrytesConverter = new ObjectTrytesConverter<ISignedItem<T>>();

        const trytes = objectToTrytesConverter.to(signedItem);

        const dataAddress = Address.fromTrytes(Trytes.fromString(this._config.dataAddress));

        this.updateProgress(0, 1, "Storing Item");
        const storageItem = await this._storageClient.save(dataAddress, trytes, tag);
        this.updateProgress(1, 1, "Storing Item");

        Object.defineProperty(data, "bundleHash", {
            value: storageItem.bundleHash.toTrytes().toString(),
            enumerable: true
        });
        Object.defineProperty(data, "transactionHashes", {
            value: storageItem.transactionHashes.map(th => th.toTrytes().toString()),
            enumerable: true
        });

        const addHash = storageItem.bundleHash.toTrytes().toString();

        let index = await this.index();
        index = index || [];
        index.push(addHash);

        await this.saveIndex(index);

        this._logger.info("<=== SignedDataTable::store", storageItem.bundleHash);

        return storageItem.bundleHash;
    }

    /**
     * Store multiple items of data in the table.
     * @param data The data to store.
     * @param tags The tag to store with the items.
     * @param clearIndex Clear the index so there is no data.
     * @returns The ids of the stored items.
     */
    public async storeMultiple(data: T[], tags?: Tag[], clearIndex?: boolean): Promise<Hash[]> {
        this._logger.info("===> SignedDataTable::storeMultiple", data, tags);

        const hashes = [];
        let index;
        if (!clearIndex) {
            index = await this.index();
        }
        index = index || [];

        this.updateProgress(0, data.length, "Storing Items");
        for (let i = 0; i < data.length; i++) {
            const signedItem = this.createSignedItem(data[i]);

            const objectToTrytesConverter = new ObjectTrytesConverter<ISignedItem<T>>();

            const trytes = objectToTrytesConverter.to(signedItem);

            const dataAddress = Address.fromTrytes(Trytes.fromString(this._config.dataAddress));

            const storageItem = await this._storageClient.save(dataAddress, trytes, tags ? tags[i] : undefined);
            this.updateProgress(i, data.length, "Storing Items");

            Object.defineProperty(data[i], "bundleHash", {
                value: storageItem.bundleHash.toTrytes().toString(),
                enumerable: true
            });
            Object.defineProperty(data[i], "transactionHashes", {
                value: storageItem.transactionHashes.map(th => th.toTrytes().toString()),
                enumerable: true
            });

            const addHash = storageItem.bundleHash.toTrytes().toString();

            index.push(addHash);

            hashes.push(storageItem.bundleHash);
        }

        await this.saveIndex(index);

        this._logger.info("<=== SignedDataTable::storeMultiple", hashes);

        return hashes;
    }

    /**
     * Update an item of data in the table.
     * @param originalId The id of the item to update.
     * @param data The data to update.
     * @param tag The tag to store with the item.
     * @returns The id of the updated item.
     */
    public async update(originalId: Hash, data: T, tag?: Tag): Promise<Hash> {
        this._logger.info("===> SignedDataTable::update", originalId, data, tag);

        const signedItem = this.createSignedItem(data);

        const objectToTrytesConverter = new ObjectTrytesConverter<ISignedItem<T>>();

        const trytes = objectToTrytesConverter.to(signedItem);

        const dataAddress = Address.fromTrytes(Trytes.fromString(this._config.dataAddress));

        this.updateProgress(0, 1, "Updating Item");
        const storageItem = await this._storageClient.save(dataAddress, trytes, tag);
        this.updateProgress(1, 1, "Updating Item");

        Object.defineProperty(data, "bundleHash", {
            value: storageItem.bundleHash.toTrytes().toString(),
            enumerable: true
        });
        Object.defineProperty(data, "transactionHashes", {
            value: storageItem.transactionHashes.map(th => th.toTrytes().toString()),
            enumerable: true
        });

        let index = await this.index();
        index = index || [];
        const removeHash = originalId.toTrytes().toString();
        const addHash = storageItem.bundleHash.toTrytes().toString();

        const idx = index.indexOf(removeHash);
        if (idx >= 0) {
            index.splice(idx, 1, addHash);
        } else {
            index.push(addHash);
        }

        await this.saveIndex(index);

        this._logger.info("<=== SignedDataTable::update", storageItem.bundleHash);

        return storageItem.bundleHash;
    }

    /**
     * Retrieve the data stored in the table.
     * @param id Id of the item to retrieve.
     * @returns The item stored in the table.
     */
    public async retrieve(id: Hash): Promise<T> {
        this._logger.info("===> SignedDataTable::retrieve", id);

        await this.loadConfig();

        let item: T;
        this.updateProgress(0, 1, "Retrieving Item");
        const allStorageItems = await this._storageClient.load([id]);
        this.updateProgress(1, 1, "Retrieving Item");

        const objectToTrytesConverter = new ObjectTrytesConverter<ISignedItem<T>>();

        if (allStorageItems && allStorageItems.length > 0) {
            const signedItem = objectToTrytesConverter.from(allStorageItems[0].data);

            if (!this.validateSignedItem(signedItem, allStorageItems[0].attachmentTimestamp)) {
                this._logger.info("<=== SignedDataTable::retrieve invalid signature", allStorageItems[0]);
            } else {
                item = signedItem.data;
            }
        }

        this._logger.info("<=== SignedDataTable::retrieve", item);

        return item;
    }

    /**
     * Retrieve all the data stored in the table.
     * @param ids Ids of all the items to retrieve, if empty will retrieve all items from index.
     * @returns The items stored in the table.
     */
    public async retrieveMultiple(ids?: Hash[]): Promise<T[]> {
        let loadIds;
        if (ArrayHelper.isTyped(ids, Hash)) {
            loadIds = ids;
        } else {
            const index = await this.index();
            if (ArrayHelper.isTyped(index, String)) {
                loadIds = index.map(b => Hash.fromTrytes(Trytes.fromString(b)));
            }
        }

        this._logger.info("===> SignedDataTable::retrieveMultiple", loadIds);

        await this.loadConfig();

        const ret: T[] = [];
        if (ArrayHelper.isTyped(loadIds, Hash)) {
            this.updateProgress(0, loadIds.length, "Retrieving Items");
            const allStorageItems = await this._storageClient.load(loadIds);
            this.updateProgress(loadIds.length, loadIds.length, "Retrieving Items");

            const objectToTrytesConverter = new ObjectTrytesConverter<ISignedItem<T>>();

            allStorageItems.forEach(storageItem => {
                const signedItem = objectToTrytesConverter.from(storageItem.data);

                if (!this.validateSignedItem(signedItem, storageItem.attachmentTimestamp)) {
                    this._logger.info("<=== SignedDataTable::retrieveMultiple invalid signature", storageItem);
                } else {
                    ret.push(signedItem.data);
                }
            });
        }

        this._logger.info("<=== SignedDataTable::retrieveMultiple", ret);

        return ret;
    }

    /**
     * Remove an item of data from the table.
     * @param id The id of the item to remove.
     */
    public async remove(id: Hash): Promise<void> {
        this._logger.info("===> SignedDataTable::remove", id);

        let index = await this.index();
        index = index || [];
        const removeHash = id.toTrytes().toString();

        const idx = index.indexOf(removeHash);
        if (idx >= 0) {
            index.splice(idx, 1);

            await this.saveIndex(index);

            this._logger.info("<=== SignedDataTable::remove");
        } else {
            this._logger.info("<=== SignedDataTable::remove nothing to remove");
        }
    }

    /**
     * Remove multiple items of data from the table.
     * @param ids The ids of the items to remove.
     */
    public async removeMultiple(ids: Hash[]): Promise<void> {
        this._logger.info("===> SignedDataTable::removeMultiple", ids);

        await this.loadConfig();

        let index = await this.index();
        index = index || [];
        let removed = false;

        for (let i = 0; i < ids.length; i++) {
            const removeHash = ids[i].toTrytes().toString();

            const idx = index.indexOf(removeHash);
            if (idx >= 0) {
                index.splice(idx, 1);

                this._logger.info("<=== SignedDataTable::removeMultiple", ids[i]);

                removed = true;
            } else {
                this._logger.info("<=== SignedDataTable::removeMultiple nothing to remove", ids[i]);
            }
        }

        if (removed) {
            await this.saveIndex(index);
        }
    }

    /**
     * Set the progress callback.
     * @param progressCallback Callback supplied with progress details.
     */
    public setProgressCallback(progressCallback: (progress: IDataTableProgress) => void): void {
        this._progressCallback = progressCallback;
    }

    /* @internal */
    private createSignedItem<U>(data: U): ISignedItem<U> {
        const rngService = RngServiceFactory.instance().create("default");

        if (ObjectHelper.isEmpty(rngService)) {
            throw new StorageError("Unable to create RngService, have you called the PAL.initialize");
        }

        const json = JsonHelper.stringify(data);

        const timestamp = Date.now();

        const platformCrypto = PlatformCryptoFactory.instance().create("default");

        return {
            // tslint:disable:restrict-plus-operands false positive
            signature: platformCrypto.sign(this._privateKey, json + timestamp.toString()),
            timestamp,
            data
        };
    }

    /* @internal */
    private validateSignedItem<U>(signedItem: ISignedItem<U>, attachmentTimestamp: number): boolean {
        // We only allow a short time to live between the attachmentTimestamp and our data
        // timestamp - this prevents the timestamp and therefore the signature being reused
        if (StringHelper.isString(signedItem.signature) &&
            NumberHelper.isNumber(attachmentTimestamp) &&
            attachmentTimestamp > 0 &&
            NumberHelper.isNumber(signedItem.timestamp) &&
            signedItem.timestamp > 0 &&
            // tslint:disable:restrict-plus-operands false positive
            attachmentTimestamp - signedItem.timestamp < SignedDataTable.TIMESTAMP_TTL) {
            const json = JsonHelper.stringify(signedItem.data) + signedItem.timestamp.toString();

            const platformCrypto = PlatformCryptoFactory.instance().create("default");

            return platformCrypto.verify(this._publicKey, json, signedItem.signature);
        } else {
            return false;
        }
    }

    /* @internal */
    private async loadConfig(): Promise<void> {
        if (ObjectHelper.isEmpty(this._config)) {
            this._logger.info("===> DataTable::getConfig");
            this._config = await this._configProvider.load(this._tableName);
            if (ObjectHelper.isEmpty(this._config) ||
                ObjectHelper.isEmpty(this._config.indexAddress) ||
                ObjectHelper.isEmpty(this._config.dataAddress)) {
                throw new StorageError("Configuration must contain at least the indexAddress and dataAddress");
            }
            this._logger.info("<=== DataTable::getConfig", this._config);
        }
    }

    /* @internal */
    private async saveConfig(): Promise<void> {
        if (!ObjectHelper.isEmpty(this._config)) {
            this._logger.info("===> DataTable::setConfig", this._config);
            await this._configProvider.save(this._tableName, this._config);
            this._logger.info("<=== DataTable::setConfig");
        }
    }

    /* @internal */
    private async saveIndex(index: DataTableIndex): Promise<void> {
        const indexAddress = Address.fromTrytes(Trytes.fromString(this._config.indexAddress));

        const signedItemIndex = this.createSignedItem(index);

        const objectToTrytesConverterIndex = new ObjectTrytesConverter<ISignedItem<DataTableIndex>>();

        const trytesIndex = objectToTrytesConverterIndex.to(signedItemIndex);

        this.updateProgress(0, 1, "Storing Index");
        const indexStorageItem = await this._storageClient.save(indexAddress, trytesIndex, SignedDataTable.INDEX_TAG);
        this._config.indexBundleHash = indexStorageItem.bundleHash.toTrytes().toString();

        await this.saveConfig();
        this.updateProgress(1, 1, "Storing Index");
    }

    /* @internal */
    private updateProgress(num: number, total: number, status: string): void {
        if (this._progressCallback) {
            this._progressCallback({
                numItems: num,
                totalItems: total,
                percent: total > 0 ? Math.ceil((num / total) * 100) : 100,
                status
            });
        }
    }
}
