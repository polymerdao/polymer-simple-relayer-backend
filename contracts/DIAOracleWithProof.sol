// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface ICrossL2Prover {
    /**
     * @notice Validates an event proof from Polymer's prove api for a non-Solana chain.
     * @notice These proofs should be generated using https://proof.devnet.polymer.zone
     * @notice Use `validateSolLogs` for Solana proofs.
     * @param proof The proof bytes
     * @return chainId The chain ID of the source chain
     * @return emittingContract The address of the contract that emitted the event
     * @return topics The event topics
     * @return unindexedData The unindexed event data
     */
    function validateEvent(bytes calldata proof)
        external
        view
        returns (uint32 chainId, address emittingContract, bytes memory topics, bytes memory unindexedData);
}

/**
 * @title DIAOracleWithProof
 * @dev Oracle contract that validates cross-chain proofs from DIA Oracle on chain 1050
 * using Polymer's CrossL2ProverV2 before accepting price updates
 */
contract DIAOracleWithProof {
    
    ICrossL2Prover public immutable prover;
    uint32 public constant DIA_CHAIN_ID = 1050;
    address public constant DIA_ORACLE_ADDRESS = 0xd7EbD2155F2734c6F80c56979CB125712A94F61C;
    
    /// @notice Mapping to store compressed values of assets (price and timestamp).
    /// @dev The stored value is a 256-bit integer where the upper 128 bits store the price and the lower 128 bits store the timestamp.
    mapping(string => uint256) public values;
    
    event OracleUpdate(string key, uint128 value, uint128 timestamp);
    
    error InvalidProof();
    error StaleUpdate(uint128 newTimestamp, uint128 currentTimestamp);
    error InvalidEmittingContract(address actual, address expected);
    error InvalidChainId(uint32 actual, uint32 expected);
    error EventDecodingFailed();
    
    constructor(address _prover) {
        require(_prover != address(0), "Invalid prover address");
        prover = ICrossL2Prover(_prover);
    }
    
    /**
     * @notice Updates the price and timestamp for a given asset key using a cross-chain proof
     * @dev Validates the proof using Polymer's CrossL2ProverV2 before updating the value
     * @param proof The cross-chain proof from Polymer
     */
    function setValueWithProof(bytes calldata proof) external {
        // Validate the proof using Polymer's CrossL2ProverV2
        (uint32 chainId, address emittingContract, , bytes memory unindexedData) = prover.validateEvent(proof);
        
        // Verify the chain ID
        if (chainId != DIA_CHAIN_ID) {
            revert InvalidChainId(chainId, DIA_CHAIN_ID);
        }
        
        // Verify the event came from the expected DIA Oracle contract
        if (emittingContract != DIA_ORACLE_ADDRESS) {
            revert InvalidEmittingContract(emittingContract, DIA_ORACLE_ADDRESS);
        }
        
        // Decode the OracleUpdate event data
        // Event signature: OracleUpdate(string key, uint128 value, uint128 timestamp)
        (string memory key, uint128 value, uint128 timestamp) = _decodeOracleUpdateEvent(unindexedData);
        
        // Check if timestamp is newer than existing value
        uint256 currentCValue = values[key];
        if (currentCValue != 0) {
            uint128 currentTimestamp = uint128(currentCValue % 2**128);
            if (timestamp <= currentTimestamp) {
                revert StaleUpdate(timestamp, currentTimestamp);
            }
        }
        
        // Update the value
        uint256 cValue = (((uint256)(value)) << 128) + timestamp;
        values[key] = cValue;
        
        emit OracleUpdate(key, value, timestamp);
    }
    
    /**
     * @notice Retrieves the price and timestamp for a given asset key
     * @param key The asset identifier (e.g., "BTC/USD")
     * @return value The stored price value
     * @return timestamp The stored timestamp
     */
    function getValue(string memory key) external view returns (uint128, uint128) {
        uint256 cValue = values[key];
        uint128 timestamp = (uint128)(cValue % 2**128);
        uint128 value = (uint128)(cValue >> 128);
        return (value, timestamp);
    }
    
    /**
     * @notice Decodes the OracleUpdate event data
     * @dev The event data should be ABI encoded with the event signature
     * @param eventData The raw event data from the proof
     * @return key The asset key from the event
     * @return value The price value from the event
     * @return timestamp The timestamp from the event
     */
    function _decodeOracleUpdateEvent(
        bytes memory eventData
    ) private view returns (
        string memory key,
        uint128 value,
        uint128 timestamp
    ) {
        // The eventData from CrossL2ProverV2 contains the indexed and non-indexed parameters
        // For OracleUpdate(string key, uint128 value, uint128 timestamp)
        // string is dynamic type, so it will be encoded with offset and length
        
        try this._tryDecodeOracleUpdate(eventData) returns (
            string memory _key,
            uint128 _value,
            uint128 _timestamp
        ) {
            return (_key, _value, _timestamp);
        } catch {
            revert EventDecodingFailed();
        }
    }
    
    /**
     * @notice Helper function to decode OracleUpdate event (external for try-catch)
     * @dev Made external to be callable within try-catch block
     */
    function _tryDecodeOracleUpdate(
        bytes memory eventData
    ) external pure returns (
        string memory key,
        uint128 value,
        uint128 timestamp
    ) {
        // Decode the event data based on Polymer's return format
        // The format depends on how CrossL2ProverV2 returns the validated event data
        (key, value, timestamp) = abi.decode(eventData, (string, uint128, uint128));
    }
    
    /**
     * @notice Get the compressed value for a key (price and timestamp combined)
     * @param key The asset identifier
     * @return The compressed value (upper 128 bits: price, lower 128 bits: timestamp)
     */
    function getCompressedValue(string memory key) external view returns (uint256) {
        return values[key];
    }
}
