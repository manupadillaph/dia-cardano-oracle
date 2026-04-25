**Milestone 1**

**Milestone Title:** Port DIA Oracle Smart Contract to Aiken

**Milestone Outputs:** 

The DIA oracle smart contract will be ported to Aiken and adapted to Cardano’s UTxO model.

Deliverables include:

* A compiled contract  
* Test coverage with unit/integration tests  
* Deployment scripts  
* Documentation for Cardano developers  
* One or more verified Cardano mainnet transaction hashes confirming successful deployment of the contract and successful execution on mainnet

**Acceptance criteria**

* An Aiken-based DIA oracle contract is deployed on Cardano mainnet and verified to compile, deploy, and function correctly. Tests demonstrate broad code coverage and show the oracle can process and return external data on-chain.  
* Transaction hash(es) confirm(s) (i) successful contract deployment on mainnet, and (ii) transaction hashes confirm successful execution of the contract on mainnet. All transaction hashes must be verifiable via a public Cardano blockchain explorer.  
* Developer documentation is considered complete when comprehensive documentation is published via the DIA main developer documentation website. The documentation must include clear instructions for the configuration of the oracle, all relevant smart contracts for accessing the oracle, and usage instructions as to how to access the DIA oracle on Cardano.

**Evidence of milestone completion**

* A public GitHub repository containing the smart contract source code, unit and integration tests with coverage results, deployment scripts, and verified Cardano mainnet transaction hashes showing successful deployment and execution.  
* DIA will provide verified Cardano mainnet transaction hashes showing (i) successful deployment of the smart contract and (ii) successful execution of the contract publishing oracle updates on mainnet. The transaction hashes will be linked to a public Cardano explorer (e.g., Cardanoscan) so reviewers can independently verify confirmation, script presence, and successful execution.

**Delivery Month**  
 2 \- Jan 2026

**Milestone Cost**  
 30.00%  
 ADA 28,350.00

**Project Completion**  
 30%

**Milestone 2**

**Milestone Title:** Implement Data Feeder and Documentation

**Milestone Outputs**

A Cardano-specific data feeder will be developed to deliver DIA’s aggregated trade data into Cardano mainnet oracle contracts.

Outputs include:

* Feeder scripts  
* Test coverage \- Which includes uptime and accuracy reports of the oracle data, and demonstrates oracle liveness as measured by confirmed oracle transactions recorded on the Cardano mainnet.  
* QA review logs \- Which demonstrate anomaly detection of any stale data or misreported prices, as well as automated alerts for any anomalies including stale data or misreport prices. A demo video of the QA logs and internal monitoring will demonstrate real-time dashboards used by DIA for quality assurance and anomaly detection. The demo will include a lightweight preview of the system feeding data for the 10 asset price feeds as referenced in the Catalyst proposal.  
* Developer documentation with integration examples.

**Acceptance criteria**

1. The feeder successfully pushes price feeds to Cardano mainnet contracts with reproducible performance for any custom oracle requests. Functionality is validated through test cases, QA review, and confirmed transactions recorded on the Cardano mainnet.  
2. The demo associated with the output “QA review logs” will include a lightweight preview of the system feeding data for the 10 asset price feeds referenced in the Catalyst proposal. This milestone is intended as an early signal to validate assumptions and demonstrate the intended architecture, rather than a complete production deployment.  
3. Developer documentation is considered complete when comprehensive documentation is published via the DIA main developer documentation website. The documentation must include clear instructions for the configuration of the oracle, all relevant smart contracts for accessing the oracle, and usage instructions as to how to access the DIA oracle on Cardano.

**Evidence of milestone completion**

GitHub repository containing:

* Feeder source code  
* Test scripts  
* Technical documentation  
* Verified Cardano mainnet transaction logs will be provided as evidence of the feeder successfully delivering live price data to the oracle  
* The demo associated with the output “QA review logs” will include a lightweight preview of the system feeding data for the 10 asset price feeds referenced in the Catalyst proposal. This milestone is intended as an early signal to validate assumptions and demonstrate the intended architecture, rather than a complete production deployment at this milestone stage.

**Delivery Month**  
 3 \- Feb 2026

**Milestone Cost**  
 30.00%

**Milestone 3**

**Milestone Title:** Implement Monitoring Library for DIA Oracles on Cardano

**Milestone Outputs**

A monitoring and alerting system will be delivered to track DIA oracles once deployed on Cardano mainnet.

Outputs include:

* QA validation report  
* Anomaly detection  
* Uptime and accuracy reports  
* Automated alerts  
* Documentation for Cardano developers

**Acceptance criteria**  
The monitoring system provides real-time visibility of DIA oracle feeds operating on Cardano mainnet. Anomalies in uptime, accuracy, or data freshness trigger automatic alerts. Functionality is validated by QA review and live on-chain performance.

The QA validation report includes integration tests validating oracle data ingestion and alert triggering, and sanity checks confirming oracle timestamp and price accuracy for each price feed. Functional correctness is assessed by verifying expected alert behavior, data freshness thresholds, and consistency with on-chain oracle activity.

Developer documentation is considered complete when comprehensive documentation is published via the DIA main developer documentation website. The documentation must include clear instructions for the configuration of the oracle, all relevant smart contracts for accessing the oracle, and usage instructions as to how to successfully integrate and access the DIA oracle on Cardano.

**Evidence of milestone completion**  
GitHub repository with monitoring library source code, configuration examples, and developer documentation. A demo video of dashboards and live mainnet logs showing feed health checks will confirm functionality.

Evidence will additionally include QA validation artifacts such as test reports, alert trigger logs, and screenshots or exports from monitoring dashboards demonstrating successful testing and validation of the monitoring system. Functional correctness is assessed by verifying expected alert behavior, data freshness thresholds, and consistency with on-chain oracle activity.

**Delivery Month**  
 4 \- Mar 2026

**Milestone Cost**  
 25.00%

**Milestone 4**

**Milestone Title:** End-to-End Integration and Deployment on Cardano Mainnet

**Milestone Outputs**

A complete end-to-end integration of DIA oracles on Cardano mainnet will be delivered.

Outputs include:

* Aiken-based smart contracts  
* Feeders  
* Monitoring stack  
* Deployment scripts  
* Sample live feeds  
* Contract addresses  
* Supporting developer documentation \- The contract addresses and supporting developer documentation will demonstrate DIA’s oracle integration on Cardano by deploying a live oracle smart contract which includes 10 asset price feeds. This documentation will also provide specific instructions for how any developer on Cardano can request any of the 2,500+ price feeds supported by DIA, and 10,000+ real-world asset price feeds. The DIA architecture has capacity to scale to this size per the request and needs of developers in the Cardano ecosystem. DIA will provide specific instructions on how to request these price feeds, the respective integration timeline, as well as instructions on how to access these feeds once live.  
* Final close-out report  
* Final closeout video

**Acceptance criteria**

* End-to-end deployment of DIA oracles on Cardano must demonstrate stable operation with 99.99% uptime and accuracy.  
* Functional verification includes successful operation of smart contracts, data feeders, and monitoring tools working together.  
* Final close-out report  
* Final closeout video  
* Developer documentation is considered complete when comprehensive documentation is published via the DIA main developer documentation website. The documentation must include clear instructions for the configuration of the oracle, all relevant smart contracts for accessing the oracle, and usage instructions as to how to access the DIA oracle on Cardano. The contract addresses and supporting developer documentation will demonstrate DIA’s oracle integration on Cardano by deploying a live oracle smart contract which includes 10 asset price feeds. This documentation will also provide specific instructions for how any developer on Cardano can request any of the 2,500+ price feeds supported by DIA, and 10,000+ real-world asset price feeds. The DIA architecture has capacity to scale to this size per the request and needs of developers in the Cardano ecosystem. DIA will provide specific instructions on how to request these price feeds, the respective integration timeline, as well as instructions on how to access these feeds once live.

**Evidence of milestone completion**

* Mainnet contract addresses, feeder logs, and E2E integration results will be shared publicly. These collective materials, especially the live mainnet smart contracts which are publishing oracle updates, will provide the functional verification of successful operation of smart contracts, data feeders, and monitoring tools working together.  
* A GitHub repository with finalized smart contract code, feeder scripts, and reproducible deployment instructions for custom oracle requests will confirm completion.  
* Developer documentation is considered complete when the aforementioned comprehensive documentation is published via the DIA main developer documentation website.  
* Link to final closeout report  
* Link to final closeout video  
* For the future adoption of the tooling developed, DIA will provide the link to an end-to-end demo, informing developers of the process for installation and accessing the live oracles on Cardano mainnet.

**Delivery Month**  
 5 \- Apr 2026

**Milestone Cost**  
 15.00%

