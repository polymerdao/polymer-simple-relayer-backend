// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../contracts/DIAOracleWithProof.sol";

contract DeployScript is Script {
    function run() external {
        // Get the private key from environment variable
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        // Prover address (Polymer's CrossL2ProverV2)
        address proverAddress = 0x95ccEAE71605c5d97A0AC0EA13013b058729d075;
        
        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy the DIAOracleWithProof contract
        DIAOracleWithProof oracle = new DIAOracleWithProof(proverAddress);
        
        // Log the deployed address
        console.log("DIAOracleWithProof deployed at:", address(oracle));
        console.log("Prover address:", proverAddress);
        console.log("Deployer address:", vm.addr(deployerPrivateKey));
        
        // Stop broadcasting
        vm.stopBroadcast();
    }
}