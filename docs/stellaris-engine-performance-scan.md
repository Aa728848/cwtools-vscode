# Stellaris Trigger / Effect 引擎性能扫描清单

> **来源**：Stellaris 4.5 Linux 版反编译结果（Ghidra dump）。
> **生成工具**：`tools/engine-cost/extract-engine-cost.cjs`。
> **数据即随扩展分发**的 `triggers.cwt` / `effects.cwt` 中的 `## cost` / `## engine_evidence` 标注。
> 在 VS Code 中把光标放在任意已标注命令上，即可看到同样的信息。

## 覆盖率

| 类别 | 已标注 | 总数 | 覆盖率 |
| --- | ---: | ---: | ---: |
| Trigger | 658 | 892 | 73.8% |
| Effect | 590 | 774 | 76.2% |
| **合计** | **1248** | **1666** | **74.9%** |

## 开销分布

| 等级 | 含义 | 数量 |
| --- | --- | ---: |
| `o(n)` | 遍历容器 | 716 |
| `o(1)` | 哈希/索引查找，常数时间 | 525 |
| `semantics` | 引擎行为与文档暗示不同 | 1 |
| `o(n^2)` | 自身实现内嵌套循环 | 2 |
| `o(n)_owned` | 遍历国家/舰队拥有的全部对象 | 1 |
| `o(log n)` | 有序容器二分查找 | 2 |
| `refresh_batch` | O(1) 开关，省掉一次全量修正刷新 | 1 |

---

## 一、需要特别注意的条目

### 1.1 二次复杂度 O(n²)

| 命令 | 类型 | 等级 | 引擎证据 |
| --- | --- | --- | --- |
| `create_military_fleet` | effect | `o(n^2)` | CCreateMilitaryFleetEffect::ExecuteActual (nested loop in the command implementation) |
| `has_point_of_interest` | trigger | `o(n^2)` | CHasPointOfInterestedTrigger::ActualEvaluate (nested loop in the command implementation) |

### 1.2 特殊等级（非 O(n)/O(1)）

| 命令 | 类型 | 等级 | 引擎证据 |
| --- | --- | --- | --- |
| `is_designable` | trigger | `semantics` | is_designable registration and per-ship size-bit test; dump L118112 / L6984185 |
| `set_update_modifiers_batch` | effect | `refresh_batch` | CSetUpdateModifiersBatch::Assign; dump L6160984 (diagnostics L6161007/L6161023/L6161068) |
| `clear_global_event_target` | effect | `o(log n)` | sorted CSavedEventTarget array with std::stable_sort; dump L408696 / L589775 |
| `save_global_event_target_as` | effect | `o(log n)` | sorted CSavedEventTarget array with std::stable_sort; dump L408696 / L589775 |
| `num_ships` | trigger | `o(n)_owned` | CFleet::CalcNumShips loops the fleet's ship array; dump L3222945 |

### 1.3 反直觉条目（与常见预期相反）

| 命令 | 类型 | 等级 | 说明 |
| --- | --- | --- | --- |
| `has_tradition` | trigger | `o(n)` | 常被当作 O(1)；实际逐指针线性扫描传统数组 |
| `has_active_tradition` | trigger | `o(n)` | 同上，线性扫描 |
| `has_any_flag` | trigger | `o(1)` | 只读 flag 数组长度，不做搜索——与 `has_*_flag` 完全不同 |
| `has_technology` | trigger | `o(1)` | 按科技 ID 直接索引，是真正的 O(1) |
| `num_researched_techs` | trigger | `o(n)` | 计数需遍历状态数组，并非读缓存计数 |
| `num_ships` | trigger | `o(n)_owned` | 遍历舰队舰船数组求和 |
| `last_increased_tech` | trigger | `o(1)` | 单次缓存指针比较 |
| `set_variable` | effect | `o(1)` | 作用域哈希映射，单次查找 |
| `save_global_event_target_as` | effect | `o(log n)` | 全局目标为有序数组 |
| `clear_global_event_target` | effect | `o(log n)` | 同上 |
| `set_update_modifiers_batch` | effect | `refresh_batch` | begin/end 之间暂停全量修正更新 |
| `is_designable` | trigger | `semantics` | 门控自动设计生成 |

---

## 二、全部 O(n) 条目（716 条，按命令名排序）

| 命令 | 类型 | 等级 | 引擎证据 |
| --- | --- | --- | --- |
| `accept_covenant` | effect | `o(n)` | CShroudCountryModule::AcceptCovenant (delegates to a helper that scans) |
| `acquired_specimen_count` | trigger | `o(n)` | CGrandArchiveCountryModule::GetCollectedSpecimens (delegates to a helper that scans) |
| `activate_fog_machine` | effect | `o(n)` | CCountryFogMachineContainer::Activate (delegates to a helper that scans) |
| `add_anomaly` | effect | `o(n)` | CAddAnomalyEffect::ExecuteActual (loop in the command implementation) |
| `add_associate_member` | effect | `o(n)` | CAddAssociateMemberEffect::ExecuteActual (loop in the command implementation) |
| `add_attunement` | effect | `o(n)` | CAddAttunementEffect::ExecuteActual (loop in the command implementation) |
| `add_blocker` | effect | `o(n)` | CAddBlockerEffect::ExecuteActual (loop in the command implementation) |
| `add_casus_belli` | effect | `o(n)` | CCasusBelli::AllowCasusBelliBetween (delegates to a helper that scans) |
| `add_claims` | effect | `o(n)` | CGalacticObject::AddClaims (delegates to a helper that scans) |
| `add_council_agenda_progress_percent` | effect | `o(n)` | CCouncilAgenda::GetCost (delegates to a helper that scans) |
| `add_deposit_category_effect` | effect | `o(n)` | CAddDepositCategoryEffect::ExecuteActual (loop in the command implementation) |
| `add_district` | effect | `o(n)` | CColony::CanAddDistrict (delegates to a helper that scans) |
| `add_edict` | effect | `o(n)` | CCountry::AddEdict (delegates to a helper that scans) |
| `add_expedition_log_entry` | effect | `o(n)` | CArchaeologicalSite::AddExpeditionLogEntry (delegates to a helper that scans) |
| `add_experience` | effect | `o(n)` | CLeader::AddExperience (delegates to a helper that scans) |
| `add_focus_progress` | effect | `o(n)` | CCountryFocusRewardManager::AddProgressToCategory (delegates to a helper that scans) |
| `add_global_ship_design` | effect | `o(n)` | CShipDesignManager::GetOrCreateGlobalShipDesign (delegates to a helper that scans) |
| `add_growth` | effect | `o(n)` | CAddGrowthEffect::ExecuteActual (loop in the command implementation) |
| `add_holding` | effect | `o(n)` | CColony::AddBuilding (delegates to a helper that scans) |
| `add_hyperlane` | effect | `o(n)` | CGalacticObject::HasHyperLaneTo (delegates to a helper that scans) |
| `add_intel` | effect | `o(n)` | CIntelManager::AccessIntelData (delegates to a helper that scans) |
| `add_intel_report` | effect | `o(n)` | CIntelManager::AccessIntelData (delegates to a helper that scans) |
| `add_modifier` | effect | `o(n)` | CAddModifierEffect::ExecuteActual (loop in the command implementation) |
| `add_notification_modifier` | effect | `o(n)` | CCountry::AddNotificationModifier (delegates to a helper that scans) |
| `add_patron_objective_counter` | effect | `o(n)` | CShroudCountryModule::UpdatePatronObjectives (delegates to a helper that scans) |
| `add_permanent_councillor` | effect | `o(n)` | CGalacticCommunity::AddPermanentCouncillor (delegates to a helper that scans) |
| `add_relic` | effect | `o(n)` | CCountry::HasRelic (delegates to a helper that scans) |
| `add_resource` | effect | `o(n)` | CEconomyCountryModule::AddResources (delegates to a helper that scans) |
| `add_resource_from_debris` | effect | `o(n)` | CAddResourceFromDebrisEffect::ExecuteActual (loop in the command implementation) |
| `add_resource_to_local_stockpile` | effect | `o(n)` | CAddResourceToLocalStockpileEffect::GetResources (delegates to a helper that scans) |
| `add_seen_bypass` | effect | `o(n)` | CCountry::HasSeenBypassInstance (delegates to a helper that scans) |
| `add_seen_bypass_type` | effect | `o(n)` | CCountry::HasSeenBypassType (delegates to a helper that scans) |
| `add_skill` | effect | `o(n)` | CLeader::LevelSkill (delegates to a helper that scans) |
| `add_skill_without_trait_selection` | effect | `o(n)` | CLeader::LevelSkill (delegates to a helper that scans) |
| `add_stage_modifier` | effect | `o(n)` | CTimedModifierCollection::AddTimedModifier (delegates to a helper that scans) |
| `add_static_war_exhaustion` | effect | `o(n)` | CWar::IsAttacker (delegates to a helper that scans) |
| `add_tech_progress` | effect | `o(n)` | CTechnologyStatus::AddAlwaysAvailableTech (delegates to a helper that scans) |
| `add_threat` | effect | `o(n)` | CDiplomacyCountryModule::AddThreat (delegates to a helper that scans) |
| `add_timed_trait` | effect | `o(n)` | CLeader::AddTimedTrait (delegates to a helper that scans) |
| `add_timeline_event` | effect | `o(n)` | CAddTimelineEventEffect::ExecuteActual (loop in the command implementation) |
| `add_to_galactic_community` | effect | `o(n)` | CGalacticCommunity::AddMember (delegates to a helper that scans) |
| `add_to_galactic_community_no_message` | effect | `o(n)` | CGalacticCommunity::AddMember (delegates to a helper that scans) |
| `add_to_galactic_council` | effect | `o(n)` | CGalacticCommunity::AddToCouncil (delegates to a helper that scans) |
| `add_to_vivarium` | effect | `o(n)` | CAddToVivariumEffect::ExecuteActual (loop in the command implementation) |
| `add_tradition` | effect | `o(n)` | CCountry::ActivateTradition (delegates to a helper that scans) |
| `add_trait` | effect | `o(n)` | CLeader::RerollInvalidTraitPicks (delegates to a helper that scans) |
| `add_trust` | effect | `o(n)` | CRelation::GetMaxTrust (delegates to a helper that scans) |
| `add_victory_score` | effect | `o(n)` | CCountry::AddVictoryScoreFromEffect (delegates to a helper that scans) |
| `add_zone` | effect | `o(n)` | CAbstractZoneEffect::FindDistrictToBuildZoneTypeInto (delegates to a helper that scans) |
| `agreement_preset` | trigger | `o(n)` | CAgreementPresetTrigger::ActualEvaluate (loop in the command implementation) |
| `artificial_pops_last_month_growth` | trigger | `o(n)` | CColony::CalcLastMonthGrowth (delegates to a helper that scans) |
| `assign_espionage_asset` | effect | `o(n)` | CSpyNetwork::GetAssetOfType (delegates to a helper that scans) |
| `assign_leader` | effect | `o(n)` | CLeaderLocation::SetLeader (delegates to a helper that scans) |
| `astral_rift_relative_difficulty` | trigger | `o(n)` | CAstralRift::GetCurrentDifficulty (delegates to a helper that scans) |
| `attacker_war_exhaustion` | trigger | `o(n)` | CWar::CalcWarExhaustion (delegates to a helper that scans) |
| `attunement` | trigger | `o(n)` | CAttunementTrigger::GetTriggerValue (loop in the command implementation) |
| `auto_move_to_planet` | effect | `o(n)` | CTriggerDatabase::PostInit (delegates to a helper that scans) |
| `begin_event_chain` | effect | `o(n)` | CCountryEventManager::HasEventChain (delegates to a helper that scans) |
| `branch_office_value` | trigger | `o(n)` | CColony::CalcBranchOfficeValue (delegates to a helper that scans) |
| `calc_true_if` | trigger | `o(n)` | CCalcTrueIfTrigger::ActualEvaluate (loop in the command implementation) |
| `can_add_random_non_blocker_deposit` | trigger | `o(n)` | CDepositTypesDatabase::CanRandomizeNonBlockersOnly (delegates to a helper that scans) |
| `can_afford_special_offer` | trigger | `o(n)` | NAIUtil::GetSpecialOfferData (delegates to a helper that scans) |
| `can_be_upgraded` | trigger | `o(n)` | CMegaStructure::CanBeUpgraded (delegates to a helper that scans) |
| `can_buy_on_market` | trigger | `o(n)` | CMarket::IsValidResource (delegates to a helper that scans) |
| `can_change_policy` | trigger | `o(n)` | CCountry::CanChangePolicy (delegates to a helper that scans) |
| `can_colonize` | trigger | `o(n)` | CPlanet::CanColonize (delegates to a helper that scans) |
| `can_control_access_for` | trigger | `o(n)` | CCountry::CanControlAccessFor (delegates to a helper that scans) |
| `can_declare_war` | trigger | `o(n)` | CCanDeclareWarTrigger::ActualEvaluate (loop in the command implementation) |
| `can_give_specimen` | trigger | `o(n)` | CGrandArchiveCountryModule::HasSpecimen (delegates to a helper that scans) |
| `can_join_factions` | trigger | `o(n)` | CPopGroup::CanJoinFactions (delegates to a helper that scans) |
| `can_research_tier` | trigger | `o(n)` | CTechnologyStatus::HasEnoughTechsForTier (delegates to a helper that scans) |
| `can_set_policy` | trigger | `o(n)` | CPolicyOption::IsValidForCountry (delegates to a helper that scans) |
| `can_set_situation_approach` | trigger | `o(n)` | CSituationType::GetApproachByKey (delegates to a helper that scans) |
| `can_spawn_random_archaeological_site` | trigger | `o(n)` | CArchaeologicalSiteManager::CanCreateRandomSite (delegates to a helper that scans) |
| `cancel_contract` | effect | `o(n)` | CCancelContractCommand::IsValid (delegates to a helper that scans) |
| `cancel_resolution` | effect | `o(n)` | CGalacticCommunity::CancelResolution (delegates to a helper that scans) |
| `change_country_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `change_dominant_species` | effect | `o(n)` | CChangeDominantSpeciesEffect::ExecuteActual (loop in the command implementation) |
| `change_government` | effect | `o(n)` | CGovernmentRestrictionsSolver::CalcRandomConfiguration (delegates to a helper that scans) |
| `change_leader_portrait` | effect | `o(n)` | CChangeLeaderPortraitEffect::ExecuteActual (loop in the command implementation) |
| `change_species_characteristics` | effect | `o(n)` | CChangeSpeciesCharacteristicsEffect::ExecuteActual (loop in the command implementation) |
| `change_species_portrait` | effect | `o(n)` | CChangeSpeciesPortraitEffect::ExecuteActual (loop in the command implementation) |
| `check_casus_belli_valid` | effect | `o(n)` | CCasusBelli::AllowCasusBelliBetween (delegates to a helper that scans) |
| `check_modifier_value` | trigger | `o(n)` | CCheckModifierValueTrigger::GetTriggerValue (loop in the command implementation) |
| `check_variable_arithmetic` | trigger | `o(n)` | CCheckVariableArithmeticTrigger::ActualEvaluate (loop in the command implementation) |
| `city_graphical_culture` | trigger | `o(n)` | CCityGraphicalCultureTrigger::GetGfxCulture (delegates to a helper that scans) |
| `clear_blockers` | effect | `o(n)` | CColonyCarrier::ClearBlockers (delegates to a helper that scans) |
| `clear_custom_ruler_and_heir_titles` | effect | `o(n)` | CCountry::ClearCustomRulerTitles (delegates to a helper that scans) |
| `clear_deposits` | effect | `o(n)` | CColonyCarrier::ClearDeposits (delegates to a helper that scans) |
| `clear_ethos` | effect | `o(n)` | CPopGroup::ClearEthos (delegates to a helper that scans) |
| `clear_global_event_targets` | effect | `o(n)` | CGameState::ClearSavedEventTargets (delegates to a helper that scans) |
| `clear_intel_report` | effect | `o(n)` | CIntelManager::AccessIntelData (delegates to a helper that scans) |
| `clear_orders` | effect | `o(n)` | CFleet::ClearOrders (delegates to a helper that scans) |
| `clear_planet_modifiers` | effect | `o(n)` | CPlanet::ClearPlanetModifiers (delegates to a helper that scans) |
| `clone_leader` | effect | `o(n)` | CCloneLeader::ExecuteActual (loop in the command implementation) |
| `close_branch_office` | effect | `o(n)` | CColony::AccessBranchOfficeOwner (delegates to a helper that scans) |
| `command_limit` | trigger | `o(n)` | CCountry::CalcCommandLimit (delegates to a helper that scans) |
| `complete_crisis_objective` | effect | `o(n)` | CCompleteCrisisObjective::ExecuteActual (loop in the command implementation) |
| `complete_deed` | effect | `o(n)` | CCompleteDeedEffect::ExecuteActual (loop in the command implementation) |
| `conditional_tooltip` | trigger | `o(n)` | CAndTrigger::ActualEvaluate (delegates to a helper that scans) |
| `conquer` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `convert_to_specialist` | effect | `o(n)` | CSubjectSpecialization::FinishConversion (delegates to a helper that scans) |
| `copy_techs_from` | effect | `o(n)` | CCopyTechsFromEffect::ExecuteActual (loop in the command implementation) |
| `count_available_contracts` | trigger | `o(n)` | CCountAvailableContracts::GetTriggerValue (loop in the command implementation) |
| `count_contracts_in_progress` | trigger | `o(n)` | CCountContractsInProgress::GetTriggerValue (loop in the command implementation) |
| `count_deposits` | trigger | `o(n)` | CCountDepositsTrigger::GetTriggerValue (loop in the command implementation) |
| `count_issued_contracts` | trigger | `o(n)` | CCountIssuedContracts::GetTriggerValue (loop in the command implementation) |
| `count_species_traits` | trigger | `o(n)` | CCountSpeciesTraitsTrigger::GetTriggerValue (loop in the command implementation) |
| `count_starbase_sizes` | trigger | `o(n)` | CCountStarbaseSizesTrigger::GetTriggerValue (loop in the command implementation) |
| `count_visible_contracts` | trigger | `o(n)` | CCountVisibleContracts::GetTriggerValue (loop in the command implementation) |
| `create_ambient_object` | effect | `o(n)` | CCreateAmbientObjectEffect::ExecuteActual (loop in the command implementation) |
| `create_army` | effect | `o(n)` | CCreateArmyEffect::ExecuteActual (loop in the command implementation) |
| `create_army_transport` | effect | `o(n)` | CCreateArmyTransport::ExecuteActual (loop in the command implementation) |
| `create_balanced_fleet` | effect | `o(n)` | CCreateBalancedFleet::ExecuteActual (loop in the command implementation) |
| `create_country` | effect | `o(n)` | CCreateCountry::ExecuteActual (loop in the command implementation) |
| `create_fleet` | effect | `o(n)` | CCreateFleet::SetUpFleet (delegates to a helper that scans) |
| `create_message` | effect | `o(n)` | CCreateMessageEffect::ExecuteActual (loop in the command implementation) |
| `create_nebula` | effect | `o(n)` | CCreateNebulaEffect::ExecuteActual (loop in the command implementation) |
| `create_pop_group` | effect | `o(n)` | CCreatePopGroupEffect::ExecuteActual (loop in the command implementation) |
| `create_random_fleet` | effect | `o(n)` | CCreateRandomFleet::ExecuteActual (loop in the command implementation) |
| `create_rebels` | effect | `o(n)` | CCreateRebelsEffect::ExecuteActual (loop in the command implementation) |
| `create_saved_leader` | effect | `o(n)` | CCreateSavedLeaderEffect::ExecuteActual (loop in the command implementation) |
| `create_ship` | effect | `o(n)` | CCreateShipEffect::ExecuteActual (loop in the command implementation) |
| `create_ship_design` | effect | `o(n)` | CShipDesignManager::GetOrCreateGlobalShipDesign (delegates to a helper that scans) |
| `create_smaller_size_creature_in_fleet` | effect | `o(n)` | CCreateSmallerSizeCreatureInFleetEffect::ExecuteActual (loop in the command implementation) |
| `create_species` | effect | `o(n)` | CCreateSpecies::ExecuteActual (loop in the command implementation) |
| `create_starbase` | effect | `o(n)` | CShipDesignManager::GetOrCreateGlobalShipDesign (delegates to a helper that scans) |
| `current_situation_approach` | trigger | `o(n)` | CSituationType::GetApproachByKey (delegates to a helper that scans) |
| `damage_ship` | effect | `o(n)` | CDamageShipEffect::ExecuteActual (loop in the command implementation) |
| `deactivate_fog_machine` | effect | `o(n)` | CCountryFogMachineContainer::Deactivate (delegates to a helper that scans) |
| `declare_war` | effect | `o(n)` | CDeclareWarEffect::ExecuteActual (loop in the command implementation) |
| `def_war_exhaustion_sum` | trigger | `o(n)` | CDefWarExhaustionSumTrigger::GetTriggerValue (loop in the command implementation) |
| `defender_war_exhaustion` | trigger | `o(n)` | CWar::CalcWarExhaustion (delegates to a helper that scans) |
| `delete_dimensional_fleet` | effect | `o(n)` | CFleet::SetToBeKilled (delegates to a helper that scans) |
| `destroy_archaeological_site` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `destroy_espionage_asset` | effect | `o(n)` | CDestroyEspionageAssetEffect::ExecuteActual (loop in the command implementation) |
| `destroy_espionage_operation` | effect | `o(n)` | CEspionageOperation::DestroyAllAssets (delegates to a helper that scans) |
| `destroy_fleet` | effect | `o(n)` | CFleet::SetToBeKilled (delegates to a helper that scans) |
| `destroy_fleet_naval_cap` | effect | `o(n)` | CDestroyFleetNavalCapEffect::ExecuteActual (loop in the command implementation) |
| `destroy_psionic_aura` | effect | `o(n)` | CPsionicAura::OnDestroy (delegates to a helper that scans) |
| `destroy_ship` | effect | `o(n)` | CShip::SetToBeKilled (delegates to a helper that scans) |
| `dismantle` | effect | `o(n)` | CFleet::SetToBeKilled (delegates to a helper that scans) |
| `displace_pop_amount` | effect | `o(n)` | CEventScope::AccessVariables (delegates to a helper that scans) |
| `distance` | trigger | `o(n)` | CDistanceTrigger::ActualEvaluate (loop in the command implementation) |
| `distance_to_core_percent` | trigger | `o(n)` | CDistanceToCorePercent::GetTriggerValue (loop in the command implementation) |
| `distance_to_empire` | trigger | `o(n)` | CDistanceToEmpireTrigger::GetTriggerValue (loop in the command implementation) |
| `downgrade_all_buildings` | effect | `o(n)` | CDowngradeAllBuildingsEffect::ExecuteActual (loop in the command implementation) |
| `downgrade_buildings_of_type` | effect | `o(n)` | CDowngradeBuildingsOfTypeEffect::ExecuteActual (loop in the command implementation) |
| `effect_on_blob` | effect | `o(n)` | CEffectOnBlobEffect::ExecuteActual (loop in the command implementation) |
| `empire_sprawl` | trigger | `o(n)` | CEmpireSprawlOverCapTrigger::GetTriggerValue (loop in the command implementation) |
| `empire_sprawl_cap_fraction` | trigger | `o(n)` | CEmpireSprawlCapFractionTrigger::GetTriggerValue (loop in the command implementation) |
| `empire_sprawl_over_cap` | trigger | `o(n)` | CEmpireSprawlOverCapTrigger::GetTriggerValue (loop in the command implementation) |
| `enclave_capacity_left` | trigger | `o(n)` | CCountryEnclaveManager::CalculateCapacity (delegates to a helper that scans) |
| `end_event_chain` | effect | `o(n)` | CCountryEventManager::EndEventChain (delegates to a helper that scans) |
| `end_fleet_contract` | effect | `o(n)` | CCountryFleetsManager::EndLeaseContract (delegates to a helper that scans) |
| `end_rivalry` | effect | `o(n)` | CCountry::IsRivaling (delegates to a helper that scans) |
| `endgame_telemetry` | effect | `o(n)` | CGameState::GetLocalPlayer (delegates to a helper that scans) |
| `establish_branch_office` | effect | `o(n)` | CColony::EstablishBranchOffice (delegates to a helper that scans) |
| `establish_communications` | effect | `o(n)` | CCountry::EstablishCommunications (delegates to a helper that scans) |
| `establish_communications_no_message` | effect | `o(n)` | CCountry::EstablishCommunications (delegates to a helper that scans) |
| `establish_contact` | effect | `o(n)` | CCountry::Contact (delegates to a helper that scans) |
| `ethos` | trigger | `o(n)` | CEthosTrigger::GetTriggerValue (loop in the command implementation) |
| `exile_leader_as` | effect | `o(n)` | CLeaderLocation::SetLeader (delegates to a helper that scans) |
| `exists` | trigger | `o(n)` | CEventTarget::ValidateScope (delegates to a helper that scans) |
| `expire_site_event` | effect | `o(n)` | CArchaeologicalSite::SetEventExpired (delegates to a helper that scans) |
| `exploitable_planets` | trigger | `o(n)` | CExploitablePlanets::GetTriggerValue (loop in the command implementation) |
| `export_modifier_duration_to_variable` | effect | `o(n)` | CTimedModifierCollection::CalcDaysLeft (delegates to a helper that scans) |
| `export_modifier_to_variable` | effect | `o(n)` | CExportModifierToVariableEffect::ExecuteActual (loop in the command implementation) |
| `faction_approval` | trigger | `o(n)` | CPopFaction::CalcApproval (delegates to a helper that scans) |
| `federation_cohesion_growth` | trigger | `o(n)` | CFederationProgression::CalcCohesionGrowth (delegates to a helper that scans) |
| `fill_astral_rift_event_pool` | effect | `o(n)` | CAstralRiftManager::FillAstralRiftEventPool (delegates to a helper that scans) |
| `finish_all_researches` | effect | `o(n)` | CTechnologyStatus::FinishAllResearch (delegates to a helper that scans) |
| `finish_current_operation_stage` | effect | `o(n)` | CEspionageOperation::FinishCurrentStage (delegates to a helper that scans) |
| `finish_current_stage` | effect | `o(n)` | CFinishCurrentStageEffect::ExecuteActual (loop in the command implementation) |
| `fire_on_action` | effect | `o(n)` | CFireOnActionEffect::ExecuteActual (loop in the command implementation) |
| `fleet_integrity` | trigger | `o(n)` | CFleet::CalcShieldValues (delegates to a helper that scans) |
| `fleet_power` | trigger | `o(n)` | CFederation::GetCachedMilitaryFleetPower (delegates to a helper that scans) |
| `force_add_civic` | effect | `o(n)` | CCountry::SetGovernmentAndCivics (delegates to a helper that scans) |
| `force_remove_civic` | effect | `o(n)` | CForceRemoveCivicEffect::ExecuteActual (loop in the command implementation) |
| `force_remove_civic_by_index` | effect | `o(n)` | CForceRemoveCivicByIndexEffect::ExecuteActual (loop in the command implementation) |
| `force_show_diplomacy` | effect | `o(n)` | CGameState::GetLocalHuman (delegates to a helper that scans) |
| `free_branch_office_building_slots` | trigger | `o(n)` | CColony::GetBranchOfficeOwner (delegates to a helper that scans) |
| `free_building_slots` | trigger | `o(n)` | CFreeBuildingSlotsTrigger::GetTriggerValue (loop in the command implementation) |
| `free_district_slots` | trigger | `o(n)` | CColonyCarrier::CalcMaxDistricts (delegates to a helper that scans) |
| `free_jobs` | trigger | `o(n)` | CColony::CalcVacantWorkspaces (delegates to a helper that scans) |
| `free_jobs_of_type` | trigger | `o(n)` | CColony::CalcVacantWorkspacesInCategory (delegates to a helper that scans) |
| `galactic_community_rank` | trigger | `o(n)` | CGalacticCommunity::GetCommunityRank (delegates to a helper that scans) |
| `get_attunement_points_for` | trigger | `o(n)` | CShroudCountryModule::GetPatronRelation (delegates to a helper that scans) |
| `get_councilor_level` | trigger | `o(n)` | CGetCouncilorLevel::GetTriggerValue (loop in the command implementation) |
| `get_trade_data` | effect | `o(n)` | NAIUtil::GetSpecialOfferData (delegates to a helper that scans) |
| `give_culling_rewards` | effect | `o(n)` | GetWeightedRandom (delegates to a helper that scans) |
| `give_specimen` | effect | `o(n)` | CGiveSpecimenEffect::ExecuteActual (loop in the command implementation) |
| `give_technology` | effect | `o(n)` | CTechnologyStatus::DoResearchTechnologyCompleted (delegates to a helper that scans) |
| `governors_skill_in_system` | trigger | `o(n)` | CGalacticObject::ForEachColony (delegates to a helper that scans) |
| `graphical_culture` | trigger | `o(n)` | CGraphicalCultureTrigger::GetGfxCulture (delegates to a helper that scans) |
| `has_active_building` | trigger | `o(n)` | CColony::HasBuildingType (delegates to a helper that scans) |
| `has_active_event` | trigger | `o(n)` | CHasActiveEventTrigger::ActualEvaluate (loop in the command implementation) |
| `has_active_first_contact_with` | trigger | `o(n)` | CFirstContactsData::GetContact (delegates to a helper that scans) |
| `has_active_focus` | trigger | `o(n)` | CHasActiveFocusTrigger::ActualEvaluate (loop in the command implementation) |
| `has_active_tradition` | trigger | `o(n)` | CCountry::HasTradition linear scan; dump L2079989 |
| `has_agreement_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_ambient_object_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_any_megastructure` | trigger | `o(n)` | CHasAnyMegastructureTrigger::ActualEvaluate (loop in the command implementation) |
| `has_any_strategic_resource` | trigger | `o(n)` | CDepositHolder::HasResources (delegates to a helper that scans) |
| `has_archaeology_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_army_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_astral_rift_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_attitude_behavior` | trigger | `o(n)` | CCountryAI::GetAttitude (delegates to a helper that scans) |
| `has_automation_setting` | trigger | `o(n)` | NScriptedActionUtil::CActiveAutomationSettings::IsActive (delegates to a helper that scans) |
| `has_available_jobs` | trigger | `o(n)` | CColony::GetPopJob (delegates to a helper that scans) |
| `has_available_spy_power` | trigger | `o(n)` | CSpyNetwork::CalcAvailableSpyPower (delegates to a helper that scans) |
| `has_branch_office` | trigger | `o(n)` | CColony::HasBranchOffice (delegates to a helper that scans) |
| `has_building` | trigger | `o(n)` | CHasBuildingTrigger::ActualEvaluate (loop in the command implementation) |
| `has_building_construction` | trigger | `o(n)` | CColony::HasQueuedBuildingOrDistrictConstruction (delegates to a helper that scans) |
| `has_carrier_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_casus_belli` | trigger | `o(n)` | CCasusBelli::AllowCasusBelliBetween (delegates to a helper that scans) |
| `has_civic` | trigger | `o(n)` | CHasCivicTrigger::ActualEvaluate (loop in the command implementation) |
| `has_claim` | trigger | `o(n)` | CDiplomacyCountryModule::HasClaim (delegates to a helper that scans) |
| `has_cloaking_detection` | trigger | `o(n)` | CShipSize::GetModifierValue (delegates to a helper that scans) |
| `has_closed_borders` | trigger | `o(n)` | CCountry::CanControlAccessFor (delegates to a helper that scans) |
| `has_completed_event_chain` | trigger | `o(n)` | CCountryEventManager::HasCompletedEventChain (delegates to a helper that scans) |
| `has_completed_event_chain_counter` | trigger | `o(n)` | CCountryEventManager::AccessEventChain (delegates to a helper that scans) |
| `has_completed_focus` | trigger | `o(n)` | CHasCompletedFocusTrigger::ActualEvaluate (loop in the command implementation) |
| `has_component` | trigger | `o(n)` | CShipGrowthStage::HasComponent (delegates to a helper that scans) |
| `has_country_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_deposit` | trigger | `o(n)` | CHasDepositTrigger::ActualEvaluate (loop in the command implementation) |
| `has_deposit_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_design_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_designation` | trigger | `o(n)` | CHasDesignationTrigger::ActualEvaluate (loop in the command implementation) |
| `has_district` | trigger | `o(n)` | CColony::CalcNumDistricts (delegates to a helper that scans) |
| `has_dna` | trigger | `o(n)` | CGrandArchiveCountryModule::GetRarityByShipCategory (delegates to a helper that scans) |
| `has_edict` | trigger | `o(n)` | CCountry::HasEdict (delegates to a helper that scans) |
| `has_election_type` | trigger | `o(n)` | CGovernmentAuthorityType::GetElectionType (delegates to a helper that scans) |
| `has_envoy_task` | trigger | `o(n)` | CHasEnvoyTaskTrigger::ActualEvaluate (loop in the command implementation) |
| `has_espionage_asset` | trigger | `o(n)` | CSpyNetwork::GetAssetOfType (delegates to a helper that scans) |
| `has_espionage_asset_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_espionage_operation_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_ethic` | trigger | `o(n)` | CHasEthicTrigger::ActualEvaluate (loop in the command implementation) |
| `has_ethos` | trigger | `o(n)` | CHasEthosTrigger::ActualEvaluate (loop in the command implementation) |
| `has_event_chain` | trigger | `o(n)` | CCountryEventManager::HasEventChain (delegates to a helper that scans) |
| `has_existing_ship_design` | trigger | `o(n)` | CCountry::GetLatestShipDesign (delegates to a helper that scans) |
| `has_extorted_faction` | trigger | `o(n)` | CHasExtortedFaction::ActualEvaluate (loop in the command implementation) |
| `has_faction` | trigger | `o(n)` | CPopFactionsCountryModule::HasPopFactionOfType (delegates to a helper that scans) |
| `has_federation_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_federation_perk` | trigger | `o(n)` | CFederationProgression::HasPerk (delegates to a helper that scans) |
| `has_first_contact_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_fleet_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_fleet_order` | trigger | `o(n)` | CHasFleetOrderTrigger::ActualEvaluate (loop in the command implementation) |
| `has_forbidden_jobs` | trigger | `o(n)` | CColony::GetPopJob (delegates to a helper that scans) |
| `has_galactic_community_emissary` | trigger | `o(n)` | CGalacticCommunity::HasAssignedEmissaryFrom (delegates to a helper that scans) |
| `has_global_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_highest_technology_score` | trigger | `o(n)` | CHasHighestTechnologyScoreTrigger::ActualEvaluate (loop in the command implementation) |
| `has_holding` | trigger | `o(n)` | CColony::CalcNumBuildings (delegates to a helper that scans) |
| `has_hyperlane_to` | trigger | `o(n)` | CGalacticObject::HasHyperLaneTo (delegates to a helper that scans) |
| `has_intel` | trigger | `o(n)` | CIntelManager::GetIntelData (delegates to a helper that scans) |
| `has_intel_level` | trigger | `o(n)` | CIntelManager::GetIntelData (delegates to a helper that scans) |
| `has_intel_report` | trigger | `o(n)` | CIntelManager::GetIntelData (delegates to a helper that scans) |
| `has_invalid_civic` | trigger | `o(n)` | CHasInvalidCivicTrigger::ActualEvaluate (loop in the command implementation) |
| `has_leader_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_megastructure_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_mission_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_modifier` | trigger | `o(n)` | CTimedModifierCollection::HasTimedModifier (delegates to a helper that scans) |
| `has_monthly_loyalty` | trigger | `o(n)` | CCountry::CalcMonthlyLoyaltyChange (delegates to a helper that scans) |
| `has_most_attunement` | trigger | `o(n)` | CHasMostAttunementTrigger::ActualEvaluate (loop in the command implementation) |
| `has_notification_modifier` | trigger | `o(n)` | CCountry::HasNotificationModifier (delegates to a helper that scans) |
| `has_passed_resolution` | trigger | `o(n)` | CHasPassedResolutionTrigger::ActualEvaluate (loop in the command implementation) |
| `has_patron_counter` | trigger | `o(n)` | CShroudCountryModule::HasPatronObjective (delegates to a helper that scans) |
| `has_patron_relation` | trigger | `o(n)` | CHasPatronRelationTrigger::ActualEvaluate (loop in the command implementation) |
| `has_planet_class` | trigger | `o(n)` | CHasPlanetClassTrigger::ActualEvaluate (loop in the command implementation) |
| `has_planet_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_planet_modifier` | trigger | `o(n)` | CPlanet::HasPlanetModifier (delegates to a helper that scans) |
| `has_policy_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_pop_faction_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_pop_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_pop_group_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_potential_claims` | trigger | `o(n)` | CCountry::HasPotentialClaimTarget (delegates to a helper that scans) |
| `has_presence` | trigger | `o(n)` | CHasPresenceTrigger::ActualEvaluate (loop in the command implementation) |
| `has_relation_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_relic` | trigger | `o(n)` | CCountry::HasRelic (delegates to a helper that scans) |
| `has_resource` | trigger | `o(n)` | CHasResourceTrigger::GetActualAmount (delegates to a helper that scans) |
| `has_rival` | trigger | `o(n)` | CCountry::IsRivaling (delegates to a helper that scans) |
| `has_secret_fealty_from_subject_of` | trigger | `o(n)` | CHasSecretFealtyFromSubjectOfTrigger::ActualEvaluate (loop in the command implementation) |
| `has_sector_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_seen_any_bypass` | trigger | `o(n)` | CCountry::HasSeenBypassType (delegates to a helper that scans) |
| `has_seen_specific_bypass` | trigger | `o(n)` | CCountry::HasSeenBypassInstance (delegates to a helper that scans) |
| `has_sensor_link_from` | trigger | `o(n)` | CCountry::HasSensorLinkFrom (delegates to a helper that scans) |
| `has_ship_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_situation_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_special_project` | trigger | `o(n)` | CCountryEventManager::HasSpecialProject (delegates to a helper that scans) |
| `has_specialist_perk` | trigger | `o(n)` | CHasSpecialistPerkTrigger::ActualEvaluate (loop in the command implementation) |
| `has_species_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_specimen` | trigger | `o(n)` | CHasSpecimen::ActualEvaluate (loop in the command implementation) |
| `has_spy_power` | trigger | `o(n)` | CSpyNetwork::GetCurrentSpyPower (delegates to a helper that scans) |
| `has_spynetwork_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_stage_modifier` | trigger | `o(n)` | CTimedModifierCollection::HasTimedModifier (delegates to a helper that scans) |
| `has_stale_intel` | trigger | `o(n)` | CIntelManager::GetIntelData (delegates to a helper that scans) |
| `has_star_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_starbase_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_starbase_size` | trigger | `o(n)` | CHasStarbaseSizeCompareTrigger::ActualEvaluate (loop in the command implementation) |
| `has_status` | trigger | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `has_storm_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_strategic_resource` | trigger | `o(n)` | CDepositHolder::HasResources (delegates to a helper that scans) |
| `has_surveyed_class` | trigger | `o(n)` | CHasSurveyedClassTrigger::ActualEvaluate (loop in the command implementation) |
| `has_term_value` | trigger | `o(n)` | CAgreementTermData::GetDiscreteValue (delegates to a helper that scans) |
| `has_total_civic_points` | trigger | `o(n)` | CCountry::CalcTotalCivicPoints (delegates to a helper that scans) |
| `has_tradition` | trigger | `o(n)` | CCountry::HasTradition linear scan; dump L2079989 (loop L2080010), called from L6885645 |
| `has_trait` | trigger | `o(n)` | CHasTrait::ActualEvaluate (loop in the command implementation) |
| `has_unlocked_all_traditions` | trigger | `o(n)` | CHasUnlockedAllTraditionsTrigger::ActualEvaluate (loop in the command implementation) |
| `has_unused_civic_points` | trigger | `o(n)` | CCountry::CalcTotalCivicPoints (delegates to a helper that scans) |
| `has_valid_civic` | trigger | `o(n)` | CHasValidCivicTrigger::ActualEvaluate (loop in the command implementation) |
| `has_war_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `has_war_goal` | trigger | `o(n)` | CCountry::GetDiplomaticAction (delegates to a helper that scans) |
| `highest_threat` | trigger | `o(n)` | CDiplomacyCountryModule::GetLargestThreat (delegates to a helper that scans) |
| `hostile_military_power` | trigger | `o(n)` | NAIUtil::CalcMilitaryPowerOfHostiles (delegates to a helper that scans) |
| `ideal_planet_class` | trigger | `o(n)` | CIdealPlanetClass::ActualEvaluate (loop in the command implementation) |
| `integrate_species` | effect | `o(n)` | CCountry::HandleSubSpeciesIntegration (delegates to a helper that scans) |
| `intel` | trigger | `o(n)` | CIntelManager::GetIntelData (delegates to a helper that scans) |
| `is_action_active` | trigger | `o(n)` | CIsActionActiveTrigger::ActualEvaluate (loop in the command implementation) |
| `is_active_resolution` | trigger | `o(n)` | CGalacticCommunity::IsResolutionActive (delegates to a helper that scans) |
| `is_astral_rift_explored` | trigger | `o(n)` | CAstralRiftManager::IsAstralRiftExploredByCountry (delegates to a helper that scans) |
| `is_astral_rift_pool_empty` | trigger | `o(n)` | CAstralRiftManager::IsAstralRiftEventPoolEmpty (delegates to a helper that scans) |
| `is_being_repaired` | trigger | `o(n)` | CFleet::IsRepairing (delegates to a helper that scans) |
| `is_being_surveyed` | trigger | `o(n)` | CIsBeingSurveyedTrigger::ActualEvaluate (loop in the command implementation) |
| `is_bottleneck_system` | trigger | `o(n)` | CGalacticObject::CalcIsGalacticBottleneck (delegates to a helper that scans) |
| `is_cardinal_patron` | trigger | `o(n)` | CShroudCountryModule::GetPatronRelation (delegates to a helper that scans) |
| `is_default_species` | trigger | `o(n)` | CCountry::GetDefaultSpecies (delegates to a helper that scans) |
| `is_fleet_idle` | trigger | `o(n)` | CFleet::IsFleetIdle (delegates to a helper that scans) |
| `is_galactic_community_member` | trigger | `o(n)` | CGalacticCommunity::IsMember (delegates to a helper that scans) |
| `is_hostile` | trigger | `o(n)` | CCountry::IsHostile (delegates to a helper that scans) |
| `is_ideal_planet_class` | trigger | `o(n)` | CTraitSet::GetIdealPlanetClass (delegates to a helper that scans) |
| `is_in_domain` | trigger | `o(n)` | CShroudCountryModule::GetAttunement (delegates to a helper that scans) |
| `is_infertile` | trigger | `o(n)` | CSpecies::IsInfertile (delegates to a helper that scans) |
| `is_influence_center` | trigger | `o(n)` | CIsInfluenceCenterTrigger::ActualEvaluate (loop in the command implementation) |
| `is_last_increased_tech_category` | trigger | `o(n)` | CIsLastIncreasedTechCategory::ActualEvaluate (loop in the command implementation) |
| `is_majority_species` | trigger | `o(n)` | CColony::CalcMajoritySpecies (delegates to a helper that scans) |
| `is_neighbor_of` | trigger | `o(n)` | CCountryBorderManager::IsBorderingCountry (delegates to a helper that scans) |
| `is_occupied_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `is_on_slave_market` | trigger | `o(n)` | CSlaveMarketManager::IsOnMarket (delegates to a helper that scans) |
| `is_part_of_galactic_council` | trigger | `o(n)` | CGalacticCommunity::IsPartOfCouncil (delegates to a helper that scans) |
| `is_permanent_councillor` | trigger | `o(n)` | CGalacticCommunity::IsPermanentCouncillor (delegates to a helper that scans) |
| `is_planet_class` | trigger | `o(n)` | CIsPlanetClassTrigger::ActualEvaluate (loop in the command implementation) |
| `is_point_of_interest` | trigger | `o(n)` | CIsPointOfInterestedTrigger::ActualEvaluate (loop in the command implementation) |
| `is_proposing_resolution` | trigger | `o(n)` | CGalacticCommunity::GetPendingResolution (delegates to a helper that scans) |
| `is_researching_any_technology` | trigger | `o(n)` | CTechnologyStatus::IsResearchingAnyTechnology (delegates to a helper that scans) |
| `is_researching_special_project` | trigger | `o(n)` | CIsResearchingSpecialProject::ActualEvaluate (loop in the command implementation) |
| `is_researching_technology` | trigger | `o(n)` | CTechnologyStatus::IsResearching (delegates to a helper that scans) |
| `is_rim_system` | trigger | `o(n)` | CGalacticObject::IsRimGalacticObject (delegates to a helper that scans) |
| `is_running_espionage_operation` | trigger | `o(n)` | CIsRunningEspionageOperationTrigger::ActualEvaluate (loop in the command implementation) |
| `is_ship_size` | trigger | `o(n)` | CShipDesign::HasShipSize (delegates to a helper that scans) |
| `is_star_class` | trigger | `o(n)` | CIsStarClassTrigger::ActualEvaluate (loop in the command implementation) |
| `is_surveyed` | trigger | `o(n)` | CCountry::HasFullySurveyedSystem (delegates to a helper that scans) |
| `is_system_locked` | trigger | `o(n)` | CFleet::IsSystemLocked (delegates to a helper that scans) |
| `is_total_war` | trigger | `o(n)` | CWar::IsTotalWar (delegates to a helper that scans) |
| `is_war_participant` | trigger | `o(n)` | CWar::IsPartOfWar (delegates to a helper that scans) |
| `issue_contract` | effect | `o(n)` | CIssueContractEffect::ExecuteActual (loop in the command implementation) |
| `join_alliance` | effect | `o(n)` | CJoinAllianceEffect::ExecuteActual (loop in the command implementation) |
| `join_war` | effect | `o(n)` | CJoinWarEffect::ExecuteActual (loop in the command implementation) |
| `join_war_on_side` | effect | `o(n)` | CWar::IsPartOfWar (delegates to a helper that scans) |
| `kill_assigned_pop_amount` | effect | `o(n)` | CKillAssignedPopAmountEffect::KillAssignedPopAmountInternal (delegates to a helper that scans) |
| `kill_exiled_leader` | effect | `o(n)` | CGameState::AccessSavedLeader (delegates to a helper that scans) |
| `kill_leader` | effect | `o(n)` | CKillLeaderEffect::ExecuteActual (loop in the command implementation) |
| `kill_pop_group` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `last_changed_species_rights_type` | trigger | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `last_completed_special_project_has_research_cost` | trigger | `o(n)` | CSpecialProjectDatabase::FindProjectType (delegates to a helper that scans) |
| `leader_lifespan` | trigger | `o(n)` | CLeader::GetLifespan (delegates to a helper that scans) |
| `lease_days` | trigger | `o(n)` | CCountryFleetsManager::GetOwnedFleetEntry (delegates to a helper that scans) |
| `leave_alliance` | effect | `o(n)` | CLeaveAllianceEffect::ExecuteActual (loop in the command implementation) |
| `link_wormholes` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `lock_animation_state` | effect | `o(n)` | CLockAnimationStateEffect::ExecuteActual (loop in the command implementation) |
| `locked_random_list` | effect | `o(n)` | CLockedRandomListEffect::GetOptionIndex (delegates to a helper that scans) |
| `make_special_trade` | effect | `o(n)` | NAIUtil::GetSpecialOfferData (delegates to a helper that scans) |
| `max_naval_capacity` | trigger | `o(n)` | CCountry::CalcNavalCapacity (delegates to a helper that scans) |
| `merge_species` | effect | `o(n)` | CCountry::HandleIdenticalSpeciesMerge (delegates to a helper that scans) |
| `modify_army` | effect | `o(n)` | CModifyArmyEffect::ExecuteActual (loop in the command implementation) |
| `modify_species` | effect | `o(n)` | CModifySpecies::ExecuteActual (loop in the command implementation) |
| `move_system` | effect | `o(n)` | CMoveSystemEffect::ExecuteActual (loop in the command implementation) |
| `mutate_species` | effect | `o(n)` | CSpecies::RandomlyMutateTraits (delegates to a helper that scans) |
| `num_active_gateways` | trigger | `o(n)` | CNumActiveGatewaysTrigger::GetTriggerValue (loop in the command implementation) |
| `num_assigned_jobs` | trigger | `o(n)` | CNumAssignedJobsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_buildings` | trigger | `o(n)` | CNumBuildingsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_candidate_supported` | trigger | `o(n)` | CElection::GetNumTimesLeaderSupported (delegates to a helper that scans) |
| `num_claims_on_system` | trigger | `o(n)` | CGalacticObject::GetClaimsBy (delegates to a helper that scans) |
| `num_communications` | trigger | `o(n)` | CNumCommunicationsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_custom_1_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumCustom1Techs (delegates to a helper that scans) |
| `num_custom_2_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumCustom2Techs (delegates to a helper that scans) |
| `num_custom_3_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumCustom3Techs (delegates to a helper that scans) |
| `num_dangerous_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumDangerousTechs (delegates to a helper that scans) |
| `num_districts` | trigger | `o(n)` | CNumDistrictsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_empires` | trigger | `o(n)` | CNumEmpiresTrigger::GetTriggerValue (loop in the command implementation) |
| `num_energy` | trigger | `o(n)` | CDepositHolder::GetNumResources (delegates to a helper that scans) |
| `num_engineering` | trigger | `o(n)` | CDepositHolder::GetNumResources (delegates to a helper that scans) |
| `num_envoys_to_federation` | trigger | `o(n)` | CNumEnvoysToFederation::GetTriggerValue (loop in the command implementation) |
| `num_espionage_assets` | trigger | `o(n)` | CSpyNetwork::GetAllAssets (delegates to a helper that scans) |
| `num_fallen_empires` | trigger | `o(n)` | CNumFallenEmpiresTrigger::GetTriggerValue (loop in the command implementation) |
| `num_free_districts` | trigger | `o(n)` | CColonyCarrier::CalcMaxDistricts (delegates to a helper that scans) |
| `num_insight_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumInsightTechs (delegates to a helper that scans) |
| `num_leader_traits` | trigger | `o(n)` | CNumLeaderTraitsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_minerals` | trigger | `o(n)` | CDepositHolder::GetNumResources (delegates to a helper that scans) |
| `num_negative_traits` | trigger | `o(n)` | CNumNegativeTraitsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_neighbor_systems` | trigger | `o(n)` | CNumNeighborSystemsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_owned_active_gateways` | trigger | `o(n)` | CNumOwnedActiveGatewaysTrigger::GetTriggerValue (loop in the command implementation) |
| `num_owned_leaders` | trigger | `o(n)` | CNumOwnedLeadersTrigger::GetTriggerValue (loop in the command implementation) |
| `num_physics` | trigger | `o(n)` | CDepositHolder::GetNumResources (delegates to a helper that scans) |
| `num_pops_assigned_to_job` | trigger | `o(n)` | CNumPopsAssignedToJob::GetTriggerValue (loop in the command implementation) |
| `num_positive_traits` | trigger | `o(n)` | CNumPositiveTraitsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_proxy_war` | trigger | `o(n)` | CCountryRelationsManager::GetNumProxyWars (delegates to a helper that scans) |
| `num_rare_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumRareTechs (delegates to a helper that scans) |
| `num_repeatable_techs` | trigger | `o(n)` | CTechnologyStatus::CalcNumRepeatableTechs (delegates to a helper that scans) |
| `num_researched_techs` | trigger | `o(n)` | CTechnologyStatus::CalcTotalTechLevels loops the status array; dump L1504171, called from L6853591 |
| `num_researched_techs_of_tier` | trigger | `o(n)` | CTechnologyStatus::CalcNumTechsOfTier (delegates to a helper that scans) |
| `num_society` | trigger | `o(n)` | CDepositHolder::GetNumResources (delegates to a helper that scans) |
| `num_starbases` | trigger | `o(n)` | CNumStarbasesTrigger::CalcNumStarbases (delegates to a helper that scans) |
| `num_storm_exploitation_buildings` | trigger | `o(n)` | CNumStormExploitationBuildingsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_trait_points` | trigger | `o(n)` | CNumTraitPointsTrigger::GetTriggerValue (loop in the command implementation) |
| `num_uncleared_blockers` | trigger | `o(n)` | CDepositHolder::CalcNumBlockerDeposits (delegates to a helper that scans) |
| `num_unemployed` | trigger | `o(n)` | CNumUnemployedTrigger::GetTriggerValue (loop in the command implementation) |
| `num_vivarium_slots` | trigger | `o(n)` | CGrandArchiveCountryModule::CalcVivariumCurrentCapacity (delegates to a helper that scans) |
| `num_zones` | trigger | `o(n)` | CNumZonesTrigger::GetTriggerValue (loop in the command implementation) |
| `off_war_exhaustion_sum` | trigger | `o(n)` | COffWarExhaustionSumTrigger::GetTriggerValue (loop in the command implementation) |
| `open_shroud_tab` | effect | `o(n)` | CInGameIdler::CloseTopBarViews (delegates to a helper that scans) |
| `opposing_ethics_divergence` | trigger | `o(n)` | COpposingEthicsDivergenceTrigger::GetTriggerValue (loop in the command implementation) |
| `order_forced_return` | effect | `o(n)` | CFleet::OrderForcedReturn (delegates to a helper that scans) |
| `organic_pops_last_month_growth` | trigger | `o(n)` | CColony::CalcLastMonthGrowth (delegates to a helper that scans) |
| `owns_any_bypass` | trigger | `o(n)` | COwnsAnyBypassTrigger::ActualEvaluate (loop in the command implementation) |
| `pass_debris_ownership` | effect | `o(n)` | CCountryEventManager::RemoveSpecialProjectsWithDebris (delegates to a helper that scans) |
| `pass_resolution` | effect | `o(n)` | CGalacticCommunity::PassResolutionType (delegates to a helper that scans) |
| `pass_resolution_no_cooldown` | effect | `o(n)` | CGalacticCommunity::PassResolutionType (delegates to a helper that scans) |
| `pass_targeted_resolution` | effect | `o(n)` | CGalacticCommunity::PassResolutionType (delegates to a helper that scans) |
| `perc_communications_with_playable` | trigger | `o(n)` | CPercCommunicationsWithPlayableTrigger::GetTriggerValue (loop in the command implementation) |
| `perform_astral_action_unlock_check` | effect | `o(n)` | CCountry::PerformAstralActionUnlockCheck (delegates to a helper that scans) |
| `planet_garrison_strength` | trigger | `o(n)` | CColony::CalcArmyPowerFor (delegates to a helper that scans) |
| `planet_happiness_above_threshold` | trigger | `o(n)` | CGalacticObject::ForEachColony (delegates to a helper that scans) |
| `planet_resource_compare` | trigger | `o(n)` | CColony::CalcSingleResourceProducesIncludePops (delegates to a helper that scans) |
| `play_sound` | effect | `o(n)` | CPlaySoundEffect::ExecuteActual (loop in the command implementation) |
| `pop_amount_percentage` | trigger | `o(n)` | CPopAmountPercentageTrigger::GetTriggerValue (loop in the command implementation) |
| `pop_ethic_amount` | trigger | `o(n)` | CPopEthicAmountTrigger::CalculateValue (delegates to a helper that scans) |
| `pop_force_remove_ethic` | effect | `o(n)` | CPopForceRemoveEthicEffect::ExecuteActual (loop in the command implementation) |
| `pop_force_transfer_ethic` | effect | `o(n)` | CPopForceTransferEthicEffect::ExecuteActual (loop in the command implementation) |
| `pop_group_crime` | trigger | `o(n)` | CPopGroupCrimeTrigger::GetTriggerValue (loop in the command implementation) |
| `pop_group_has_trait` | trigger | `o(n)` | CPopGroupHasTrait::ActualEvaluate (loop in the command implementation) |
| `pop_has_happiness` | trigger | `o(n)` | CCountry::SpeciesHasHappiness (delegates to a helper that scans) |
| `progress_all_researches` | effect | `o(n)` | CTechnologyStatus::ProgressAllResearch (delegates to a helper that scans) |
| `prolong_fleet_contract` | effect | `o(n)` | CCountryFleetsManager::ProlongLeaseContract (delegates to a helper that scans) |
| `propose_resolution` | effect | `o(n)` | CProposeResolutionEffect::ExecuteActual (loop in the command implementation) |
| `reanimate_space_fauna` | effect | `o(n)` | CReanimateSpaceFaunaEffect::ExecuteActual (loop in the command implementation) |
| `rebuild_owned_starbase_designs` | effect | `o(n)` | CCountry::RefreshOwnedStarbaseDesigns (delegates to a helper that scans) |
| `recalculate_storm_influence_field` | effect | `o(n)` | CCosmicStormInfluenceField::RecalculateAllSystems (delegates to a helper that scans) |
| `refresh_accords` | effect | `o(n)` | CShroudCountryModule::UpdateAccordsUnlocking (delegates to a helper that scans) |
| `refresh_auto_generated_ship_designs` | effect | `o(n)` | CCountry::SetDefaultShipDesignsForOwnerType (delegates to a helper that scans) |
| `refresh_leader_pool` | effect | `o(n)` | CLeaderCountryModule::UpdateLeaderPools (delegates to a helper that scans) |
| `refresh_psionic_aura_type` | effect | `o(n)` | CRefreshPsionicAuraTypeEffect::ExecuteActual (loop in the command implementation) |
| `refresh_species_rights` | effect | `o(n)` | CSpeciesRightsModule::ConfigureForCountry (delegates to a helper that scans) |
| `refuse_covenant` | effect | `o(n)` | CShroudCountryModule::RefuseCovenant (delegates to a helper that scans) |
| `relative_encryption_decryption` | trigger | `o(n)` | CRelativeEncryptionDecryptionTrigger::CalcRelativeValue (delegates to a helper that scans) |
| `release_vivarium_fauna` | effect | `o(n)` | CReleaseVivariumFaunaEffect::ExecuteActual (loop in the command implementation) |
| `release_vivarium_fauna_count` | effect | `o(n)` | CReleaseVivariumFaunaCountEffect::ExecuteActual (loop in the command implementation) |
| `remove_agreement_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_all_armies` | effect | `o(n)` | NPlanetArmies::RemoveAll (delegates to a helper that scans) |
| `remove_all_buildings` | effect | `o(n)` | CColony::ClearBuildings (delegates to a helper that scans) |
| `remove_all_districts` | effect | `o(n)` | CColony::ClearDistricts (delegates to a helper that scans) |
| `remove_ambient_object_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_archaeology_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_army` | effect | `o(n)` | CCountry::KillArmy (delegates to a helper that scans) |
| `remove_army_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_ascension_perk` | effect | `o(n)` | CCountry::RemoveAscensionPerk (delegates to a helper that scans) |
| `remove_associate_member` | effect | `o(n)` | CRemoveAssociateMemberEffect::ExecuteActual (loop in the command implementation) |
| `remove_astral_rift_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_auto_move_target` | effect | `o(n)` | CFleet::ClearAutoMoveTarget (delegates to a helper that scans) |
| `remove_carrier_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_claims` | effect | `o(n)` | CGalacticObject::RemoveClaims (delegates to a helper that scans) |
| `remove_country_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag linear scan; dump L7062161 (loop L7062175) |
| `remove_deposit_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_design_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_district` | effect | `o(n)` | CColony::RemoveDistrict (delegates to a helper that scans) |
| `remove_envoys_to` | effect | `o(n)` | CCountryEspionageManager::AccessSpyNetwork (delegates to a helper that scans) |
| `remove_espionage_asset_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_espionage_operation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_federation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_first_contact_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_fleet_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_from_federation` | effect | `o(n)` | CFederation::RemoveMember (delegates to a helper that scans) |
| `remove_from_galactic_community` | effect | `o(n)` | CGalacticCommunity::RemoveMember (delegates to a helper that scans) |
| `remove_from_galactic_council` | effect | `o(n)` | CGalacticCommunity::RemoveFromCouncil (delegates to a helper that scans) |
| `remove_global_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_global_ship_design` | effect | `o(n)` | CShipDesignManager::GetGlobalShipDesign (delegates to a helper that scans) |
| `remove_hyperlane` | effect | `o(n)` | CGalacticObject::HasHyperLaneTo (delegates to a helper that scans) |
| `remove_leader_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_megastructure_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_mission_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_modifier` | effect | `o(n)` | CRemoveModifierEffect::ExecuteActual (loop in the command implementation) |
| `remove_notification_modifier` | effect | `o(n)` | CCountry::RemoveNotificationModifier (delegates to a helper that scans) |
| `remove_patron` | effect | `o(n)` | CShroudCountryModule::RemovePatron (delegates to a helper that scans) |
| `remove_permanent_councillor` | effect | `o(n)` | CGalacticCommunity::RemovePermanentCouncillor (delegates to a helper that scans) |
| `remove_planet_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_point_of_interest` | effect | `o(n)` | CCountryEventManager::RemovePointOfInterest (delegates to a helper that scans) |
| `remove_pop_faction_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_pop_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_pop_group_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_random_district` | effect | `o(n)` | CColony::RemoveRandomDistrict (delegates to a helper that scans) |
| `remove_relation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_relic` | effect | `o(n)` | CCountry::HasRelic (delegates to a helper that scans) |
| `remove_saved_leader` | effect | `o(n)` | CLeader::SetToBeKilled (delegates to a helper that scans) |
| `remove_sector_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_ship_design` | effect | `o(n)` | CShipDesignCollection::RemoveShipDesign (delegates to a helper that scans) |
| `remove_ship_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_situation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_species_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_specimen` | effect | `o(n)` | CRemoveSpecimenEffect::GetSpecimen (delegates to a helper that scans) |
| `remove_spynetwork_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_stage_modifier` | effect | `o(n)` | CTimedModifierCollection::RemoveTimedModifier (delegates to a helper that scans) |
| `remove_star_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_starbase_building` | effect | `o(n)` | CRemoveStarbaseBuildingEffect::ExecuteActual (loop in the command implementation) |
| `remove_starbase_component` | effect | `o(n)` | CStarbase::RemoveStandaloneComponent (delegates to a helper that scans) |
| `remove_starbase_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_starbase_module` | effect | `o(n)` | CRemoveStarbaseModuleEffect::ExecuteActual (loop in the command implementation) |
| `remove_terrified` | effect | `o(n)` | CRemoveTerrifiedEffect::ExecuteActual (loop in the command implementation) |
| `remove_tradition` | effect | `o(n)` | CCountry::RemoveTradition (delegates to a helper that scans) |
| `remove_trait` | effect | `o(n)` | CRemoveTraitEffect::ExecuteActual (loop in the command implementation) |
| `remove_war_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `remove_war_participant` | effect | `o(n)` | CWar::SendLeftWarMessages (delegates to a helper that scans) |
| `remove_zone` | effect | `o(n)` | CRemoveZoneEffect::ExecuteActual (loop in the command implementation) |
| `rename_species` | effect | `o(n)` | CRenameSpeciesEffect::ExecuteActual (loop in the command implementation) |
| `renew_bypass_lock` | effect | `o(n)` | CBypass::RenewLock (delegates to a helper that scans) |
| `repair_all_buildings` | effect | `o(n)` | CColony::RepairAllBuildings (delegates to a helper that scans) |
| `repair_amount` | effect | `o(n)` | CRepairAmountEffect::ExecuteActual (loop in the command implementation) |
| `repair_armor_amount` | effect | `o(n)` | CRepairArmorAmountEffect::ExecuteActual (loop in the command implementation) |
| `repair_armor_percentage` | effect | `o(n)` | CRepairArmorPercentageEffect::ExecuteActual (loop in the command implementation) |
| `repair_percentage` | effect | `o(n)` | CRepairPercentageEffect::ExecuteActual (loop in the command implementation) |
| `repair_shield_amount` | effect | `o(n)` | CRepairShieldAmountEffect::ExecuteActual (loop in the command implementation) |
| `repair_shield_percentage` | effect | `o(n)` | CRepairShieldPercentageEffect::ExecuteActual (loop in the command implementation) |
| `reroll_deposits` | effect | `o(n)` | CColonyCarrier::RandomizeDeposits (delegates to a helper that scans) |
| `reset_current_stage` | effect | `o(n)` | CArchaeologicalSite::ResetCurrentStage (delegates to a helper that scans) |
| `reset_event_chain_counter` | effect | `o(n)` | CCountryEventManager::AccessEventChain (delegates to a helper that scans) |
| `reset_growth` | effect | `o(n)` | CResetGrowthEffect::ExecuteActual (loop in the command implementation) |
| `reset_policy_cooldowns` | effect | `o(n)` | CCountry::ResetPolicyCooldowns (delegates to a helper that scans) |
| `resettle_pop` | effect | `o(n)` | CResettlePopCommand::CalcCost (delegates to a helper that scans) |
| `return_leader_from_exile` | effect | `o(n)` | CGameState::AccessSavedLeader (delegates to a helper that scans) |
| `reverse_has_relation_flag` | trigger | `o(n)` | CHasFlagTrigger::ActualEvaluate (loop in the command implementation) |
| `sacrifice_assigned_pop_amount` | effect | `o(n)` | CKillAssignedPopAmountEffect::KillAssignedPopAmountInternal (delegates to a helper that scans) |
| `sacrifice_pop_group` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `save_event_target_as` | effect | `o(n)` | CEventScope::SaveEventTarget (delegates to a helper that scans) |
| `scientist_count` | trigger | `o(n)` | CScientistCount::GetTriggerValue (loop in the command implementation) |
| `set_adjective` | effect | `o(n)` | CSetAdjectiveEffect::ExecuteActual (loop in the command implementation) |
| `set_agreement_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_agreement_preset` | effect | `o(n)` | CAgreement::SetTermData (delegates to a helper that scans) |
| `set_agreement_terms` | effect | `o(n)` | CSetAgreementTermsEffect::ExecuteActual (loop in the command implementation) |
| `set_allow_subjects_to_join` | effect | `o(n)` | CFederationProgression::SetSetting (delegates to a helper that scans) |
| `set_ambient_object_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_archaeology_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_army_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_asteroid_belt` | effect | `o(n)` | CSetAsteroidBeltEffect::ExecuteActual (loop in the command implementation) |
| `set_astral_rift_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_attunement` | effect | `o(n)` | CShroudCountryModule::GetPatronRelation (delegates to a helper that scans) |
| `set_carrier_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_confused` | effect | `o(n)` | CSetConfusedEffect::ExecuteActual (loop in the command implementation) |
| `set_controller` | effect | `o(n)` | CStarbaseManager::AccessStarbaseThruLookup (delegates to a helper that scans) |
| `set_council_position` | effect | `o(n)` | CSetCouncilPosition::ExecuteActual (loop in the command implementation) |
| `set_council_position_title_female` | effect | `o(n)` | CCountry::GetCustomCouncilTitle (delegates to a helper that scans) |
| `set_council_position_title_male` | effect | `o(n)` | CCountry::GetCustomCouncilTitle (delegates to a helper that scans) |
| `set_council_position_to_council` | effect | `o(n)` | CUnlockCouncilPositionCommand::IsValid (delegates to a helper that scans) |
| `set_country_code_flags` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_country_flag` | effect | `o(n)` | CHasFlagTrigger::ActualEvaluate linear scan; dump L6751399 (loop L6751417). Set/clear scan too: CPdxIntegerFlags::SetFlag L7062093, ClearFlag L7062161 |
| `set_country_type` | effect | `o(n)` | CCountry::SetCountryType (delegates to a helper that scans) |
| `set_current_stage` | effect | `o(n)` | CArchaeologicalSite::SetStageIndex (delegates to a helper that scans) |
| `set_deposit` | effect | `o(n)` | CColonyCarrier::ClearDeposits (delegates to a helper that scans) |
| `set_deposit_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_design_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_disable_at_health` | effect | `o(n)` | CSetDisableAtHealth::ExecuteActual (loop in the command implementation) |
| `set_empire_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_empire_name` | effect | `o(n)` | CSetEmpireNameEffect::ExecuteActual (loop in the command implementation) |
| `set_espionage_asset_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_espionage_operation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_faction_extorted` | effect | `o(n)` | CSetFactionExtortedEffect::ExecuteActual (loop in the command implementation) |
| `set_faction_hostility` | effect | `o(n)` | CSetFactionHostilityEffect::ExecuteActual (loop in the command implementation) |
| `set_fauna_fleet_growth_stance` | effect | `o(n)` | CSetFaunaFleetGrowthStanceEffect::ExecuteActual (loop in the command implementation) |
| `set_federation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_federation_leader` | effect | `o(n)` | CFederation::IsMember (delegates to a helper that scans) |
| `set_federation_settings` | effect | `o(n)` | CSetFederationSettingsEffect::ExecuteActual (loop in the command implementation) |
| `set_federation_type` | effect | `o(n)` | CFederationProgression::SetType (delegates to a helper that scans) |
| `set_first_contact_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_first_contact_stage` | effect | `o(n)` | CFirstContact::SetCurrentStage (delegates to a helper that scans) |
| `set_fleet_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_free_migration` | effect | `o(n)` | CFederationProgression::SetSetting (delegates to a helper that scans) |
| `set_galactic_emperor` | effect | `o(n)` | CGalacticCommunity::UnSetEmperor (delegates to a helper that scans) |
| `set_global_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_graphical_culture` | effect | `o(n)` | CSetGraphicalCultureEffect::ExecuteActual (loop in the command implementation) |
| `set_habitability_trait` | effect | `o(n)` | CSpecies::GetPlanetClassPreferenceTrait (delegates to a helper that scans) |
| `set_hostile` | effect | `o(n)` | CCountry::UpdateRelationCache (delegates to a helper that scans) |
| `set_leader` | effect | `o(n)` | CGameState::AccessSavedLeader (delegates to a helper that scans) |
| `set_leader_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_location` | effect | `o(n)` | CStarbaseManager::GetStarbaseThruLookup (delegates to a helper that scans) |
| `set_megastructure_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_mission` | effect | `o(n)` | CCountryEventManager::AccessMissionByType (delegates to a helper that scans) |
| `set_mission_counter` | effect | `o(n)` | CCountryEventManager::AccessMissionByType (delegates to a helper that scans) |
| `set_mission_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_name` | effect | `o(n)` | CSetNameEffect::ExecuteActual (loop in the command implementation) |
| `set_only_leader_builds_fleets` | effect | `o(n)` | CFederationProgression::SetSetting (delegates to a helper that scans) |
| `set_origin` | effect | `o(n)` | CCountry::SetGovernmentAndCivics (delegates to a helper that scans) |
| `set_overclock` | effect | `o(n)` | CSetOverclockEffect::ExecuteActual (loop in the command implementation) |
| `set_owner` | effect | `o(n)` | CMegaStructure::SetOwner (delegates to a helper that scans) |
| `set_planet_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_planet_name` | effect | `o(n)` | CSetPlanetNameEffect::ExecuteActual (loop in the command implementation) |
| `set_player` | effect | `o(n)` | CSetPlayerEffect::ExecuteActual (loop in the command implementation) |
| `set_policy` | effect | `o(n)` | CPolicyOption::IsValidForCountry (delegates to a helper that scans) |
| `set_policy_cooldown` | effect | `o(n)` | CCountry::GetPolicyData (delegates to a helper that scans) |
| `set_pop_faction` | effect | `o(n)` | CPopGroup::CanJoinFactions (delegates to a helper that scans) |
| `set_pop_faction_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_pop_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_pop_group_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_relation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_resource` | effect | `o(n)` | CEconomyCountryModule::SetResource (delegates to a helper that scans) |
| `set_resource_converter` | effect | `o(n)` | CEconomyCountryModule::SetResourceConverter (delegates to a helper that scans) |
| `set_rule_can_subject_do_diplomacy` | effect | `o(n)` | CCountry::ClearRivalsAndReverseRivals (delegates to a helper that scans) |
| `set_rule_can_subject_vote` | effect | `o(n)` | CCountry::CheckVotingRights (delegates to a helper that scans) |
| `set_rule_join_overlord_wars` | effect | `o(n)` | CCountry::JoinOverlordWars (delegates to a helper that scans) |
| `set_ruler_title_female` | effect | `o(n)` | CSetRulerTitleFemaleEffect::ExecuteActual (loop in the command implementation) |
| `set_ruler_title_male` | effect | `o(n)` | CSetRulerTitleMaleEffect::ExecuteActual (loop in the command implementation) |
| `set_saved_date` | effect | `o(n)` | CPdxIntegerFlags::SetFlag (delegates to a helper that scans) |
| `set_sector_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_ship_design` | effect | `o(n)` | CSetShipDesignEffect::ExecuteActual (loop in the command implementation) |
| `set_ship_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_ship_prefix` | effect | `o(n)` | CSetShipPrefixEffect::ExecuteActual (loop in the command implementation) |
| `set_situation_approach` | effect | `o(n)` | CSituationType::GetApproachByKey (delegates to a helper that scans) |
| `set_situation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_skill` | effect | `o(n)` | CLeader::SetSkillLevel (delegates to a helper that scans) |
| `set_spawn_system_batch` | effect | `o(n)` | CGameState::GenerateGalacticMap (delegates to a helper that scans) |
| `set_species_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_species_homeworld` | effect | `o(n)` | CSetSpeciesHomeworldEffect::ExecuteActual (loop in the command implementation) |
| `set_species_identity` | effect | `o(n)` | CSetSpeciesIdentityEffect::ExecuteActual (loop in the command implementation) |
| `set_spynetwork_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_star_class` | effect | `o(n)` | CGalacticObject::AccessStarPlanetObject (delegates to a helper that scans) |
| `set_star_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_starbase_building` | effect | `o(n)` | CStarbase::SetBuilding (delegates to a helper that scans) |
| `set_starbase_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_starbase_module` | effect | `o(n)` | CStarbase::SetModule (delegates to a helper that scans) |
| `set_starbase_size` | effect | `o(n)` | CStarbaseLevelTypeDatabase::FindLevelForShipSize (delegates to a helper that scans) |
| `set_storm_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_subject_of` | effect | `o(n)` | CCountry::ClearOverlord (delegates to a helper that scans) |
| `set_surveyed` | effect | `o(n)` | CSetSurveyedEffect::ExecuteActual (loop in the command implementation) |
| `set_terrified_by` | effect | `o(n)` | CSetTerrifiedByEffect::ExecuteActual (loop in the command implementation) |
| `set_timed_agreement_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_ambient_object_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_archaeology_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_army_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_carrier_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_country_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_deposit_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_design_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_espionage_asset_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_espionage_operation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_federation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_first_contact_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_fleet_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_global_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_leader_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_megastructure_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_planet_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_pop_faction_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_pop_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_pop_group_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_relation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_sector_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_ship_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_situation_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_species_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_spynetwork_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_star_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_starbase_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_timed_war_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_tutorial_level` | effect | `o(n)` | CCountry::SetTutorialLevel (delegates to a helper that scans) |
| `set_visited` | effect | `o(n)` | CCountry::HasVisited (delegates to a helper that scans) |
| `set_war_flag` | effect | `o(n)` | CPdxIntegerFlags::ClearFlag (delegates to a helper that scans) |
| `set_war_goal` | effect | `o(n)` | CSetWarGoalEffect::ExecuteActual (loop in the command implementation) |
| `shift_ethic` | effect | `o(n)` | CCountryEthos::ShiftTowardsEthic (delegates to a helper that scans) |
| `ship_size_cost_resource_percent` | trigger | `o(n)` | CTriggeredResourceTable::CalcResources (delegates to a helper that scans) |
| `spawn_astral_rift` | effect | `o(n)` | CSpawnAstralRiftEffect::ExecuteActual (loop in the command implementation) |
| `spawn_custom_debris` | effect | `o(n)` | CSpawnCustomDebrisEffect::ExecuteActual (loop in the command implementation) |
| `spawn_planet` | effect | `o(n)` | CSpawnPlanetEffect::ExecuteActual (loop in the command implementation) |
| `spawn_random_anomaly` | effect | `o(n)` | CSpawnRandomAnomalyEffect::ExecuteActual (loop in the command implementation) |
| `spawn_random_storm` | effect | `o(n)` | CSpawnRandomStormEffect::ExecuteActual (loop in the command implementation) |
| `spawn_system` | effect | `o(n)` | CSystemInitializerUseCounter::HasReachedMaxUses (delegates to a helper that scans) |
| `starbase_buildable_is_in_queue_before` | trigger | `o(n)` | CStarbaseBuildableIsInQueueBefore::ActualEvaluate (loop in the command implementation) |
| `start_situation` | effect | `o(n)` | CStartSituationEffect::ExecuteActual (loop in the command implementation) |
| `start_storm_area_placing` | effect | `o(n)` | CGameState::IsLocalPlayer (delegates to a helper that scans) |
| `start_terraform_process` | effect | `o(n)` | CStartTerraformProcessEffect::ExecuteActual (loop in the command implementation) |
| `steal_planet_output` | effect | `o(n)` | CStealPlanetOutputEffect::ExecuteActual (loop in the command implementation) |
| `steal_relic` | effect | `o(n)` | CStealRelicEffect::ExecuteActual (loop in the command implementation) |
| `steal_specimens` | effect | `o(n)` | CStealSpecimensEffect::ExecuteActual (loop in the command implementation) |
| `storm_apply_aftermath_modifier` | effect | `o(n)` | CStormApplyAftermathModifier::ExecuteActual (loop in the command implementation) |
| `support` | trigger | `o(n)` | CLeader::ForEachFactionMatchingEthic (delegates to a helper that scans) |
| `timed_flag_days_left` | trigger | `o(n)` | CTimedFlagDaysLeftTrigger::GetTriggerValue (loop in the command implementation) |
| `total_country_workforce_with_job_tag` | trigger | `o(n)` | CTotalCountryWorkforceWithJobTagTrigger::GetTriggerValue (loop in the command implementation) |
| `total_system_workforce_with_job_tag` | trigger | `o(n)` | CGalacticObject::ForEachColony (delegates to a helper that scans) |
| `total_workforce_with_job_tag` | trigger | `o(n)` | CTotalWorkforceWithJobTagTrigger::CalcWorkforceForColony (delegates to a helper that scans) |
| `trade_action_value` | trigger | `o(n)` | CTradeActionValueTrigger::GetTriggerValue (loop in the command implementation) |
| `transfer_carrier` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `transfer_pop_amount` | effect | `o(n)` | CEventTarget::GetScopeType (delegates to a helper that scans) |
| `transfer_resource_stockpile` | effect | `o(n)` | CTransferResourceStockpileEffect::ExecuteActual (loop in the command implementation) |
| `transfer_resources_to_empire` | effect | `o(n)` | CTransferResourcesToEmpireEffect::ExecuteActual (loop in the command implementation) |
| `triumph_days_left` | trigger | `o(n)` | CCountry::GetRelicCooldown (delegates to a helper that scans) |
| `unassign_espionage_asset` | effect | `o(n)` | CEspionageOperation::GetAssetOfType (delegates to a helper that scans) |
| `unassign_leader` | effect | `o(n)` | CLeaderLocation::SetLeader (delegates to a helper that scans) |
| `unlock_council_selection` | effect | `o(n)` | CGovernment::DetermineCouncilorTypes (delegates to a helper that scans) |
| `unlock_exhibit` | effect | `o(n)` | CUnlockExhibitEffect::ExecuteActual (loop in the command implementation) |
| `used_defense_platform_capacity_percent` | trigger | `o(n)` | CStarbase::CalcCurrentDefensePlatformCapacityUsage (delegates to a helper that scans) |
| `used_favors_on_last_resolution` | trigger | `o(n)` | CCountry::GetNumFavorsUsedForResolution (delegates to a helper that scans) |
| `used_starbase_capacity` | trigger | `o(n)` | CCountry::CalcNumUpgradingOutpostStarbases (delegates to a helper that scans) |
| `used_starbase_capacity_percent` | trigger | `o(n)` | CCountry::CalcNumUpgradingOutpostStarbases (delegates to a helper that scans) |
| `using_war_goal` | trigger | `o(n)` | CWar::IsAttacker (delegates to a helper that scans) |
| `valid_planet_killer_target` | trigger | `o(n)` | CDestroyPlanetFleetOrder::IsPossible (delegates to a helper that scans) |
| `validate_and_repair_planet_buildings_and_districts` | effect | `o(n)` | CColony::ClearAndReplaceInvalidBuildingsAndDistricts (delegates to a helper that scans) |
| `vassals` | trigger | `o(n)` | CVassalsTrigger::GetTriggerValue (loop in the command implementation) |
| `waystation_has_remote_collection` | trigger | `o(n)` | CStarbase::RemoteNetworkResourceCollection (delegates to a helper that scans) |
| `waystation_network_has_remote_collection` | trigger | `o(n)` | CWaystationNetwork::HasRemoteCollection (delegates to a helper that scans) |
| `waystation_network_stockpile_used` | trigger | `o(n)` | NWaystationUtil::GetWaylineStockpileUsed (delegates to a helper that scans) |
| `would_join_war` | trigger | `o(n)` | CWouldJoinWarTrigger::ActualEvaluate (loop in the command implementation) |

---

## 三、全部 O(1) 条目（525 条，按命令名排序）

| 命令 | 类型 | 等级 | 引擎证据 |
| --- | --- | --- | --- |
| `activate_crisis_progression` | effect | `o(1)` | CActivateCrisisProgression::ExecuteActual (no scan in the command or its direct callees) |
| `activate_saved_leader` | effect | `o(1)` | CActivateSavedLeaderEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_ascension_perk` | effect | `o(1)` | CAddAscensionPerk::ExecuteActual (no scan in the command or its direct callees) |
| `add_asteroid_belt` | effect | `o(1)` | CAddAsteroidBeltEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_awareness` | effect | `o(1)` | CAddAwarenessEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_cohesion` | effect | `o(1)` | CAddCohesionEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_colony_progress` | effect | `o(1)` | CAddColonyProgressEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_council_agenda_progress` | effect | `o(1)` | CAddCouncilAgendaProgressEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_custodian_term_days` | effect | `o(1)` | CAddCustodianTermDaysEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_deposit` | effect | `o(1)` | CAddDepositEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_espionage_information` | effect | `o(1)` | CAddEspionageInformationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_favors` | effect | `o(1)` | CAddFavorsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_federation_experience` | effect | `o(1)` | CAddFederationExperienceEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_imperial_authority` | effect | `o(1)` | CAddImperialAuthorityEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_loyalty` | effect | `o(1)` | CAddLoyaltyEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_mission_progress` | effect | `o(1)` | CAddMissionProgressEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_monthly_resource_mult` | effect | `o(1)` | CAddMonthlyResourceMultEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_opinion_modifier` | effect | `o(1)` | CAddOpinionModifierEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_planet_devastation` | effect | `o(1)` | CAddPlanetDevastationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_pop_amount` | effect | `o(1)` | CAddPopAmountEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_random_non_blocker_deposit` | effect | `o(1)` | CAddRandomNonBlockerDepositEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_situation_progress` | effect | `o(1)` | CAddSituationProgress::ExecuteActual (no scan in the command or its direct callees) |
| `add_spy_network_level` | effect | `o(1)` | CAddSpyNetworkLevelEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_stage_clues` | effect | `o(1)` | CAddStageCluesEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_starbase_component` | effect | `o(1)` | CAddStarbaseComponentEffect::ExecuteActual (no scan in the command or its direct callees) |
| `add_variable` | effect | `o(1)` | CAddVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `additional_crisis_strength` | trigger | `o(1)` | CAdditionalCrisisStrengthTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `advanced_authority_refresh` | effect | `o(1)` | CAdvancedAuthorityRefreshEffect::ExecuteActual (no scan in the command or its direct callees) |
| `ai_armor_ratio` | trigger | `o(1)` | CAiArmorRatioTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `ai_shields_ratio` | trigger | `o(1)` | CAiShieldsRatioTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `allowed_crisis_type` | trigger | `o(1)` | CAllowedCrisisTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `always` | trigger | `o(1)` | CAlwaysTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `army_type` | trigger | `o(1)` | CArmyTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `astral_rifts_completed` | trigger | `o(1)` | CAstralRiftsCompletedTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `balance` | trigger | `o(1)` | CBalanceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `bioship_can_grow` | trigger | `o(1)` | CBioshipCanGrow::ActualEvaluate (no scan in the command or its direct callees) |
| `break` | effect | `o(1)` | CBreakEffect::ExecuteActual (no scan in the command or its direct callees) |
| `calculate_modifier` | effect | `o(1)` | CCalculateModifierEffect::ExecuteActual (no scan in the command or its direct callees) |
| `can_access_system` | trigger | `o(1)` | CCanAccessSystem::ActualEvaluate (no scan in the command or its direct callees) |
| `can_be_crisis_terraformed` | trigger | `o(1)` | CCanBeCrisisTerraformedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_be_reanimated` | trigger | `o(1)` | CCanBeReanimatedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_copy_random_tech_from` | trigger | `o(1)` | CCanCopyRandomTechFromTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_have_first_contact_site_with` | trigger | `o(1)` | CCanHaveFirstContactSiteWithTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_live_on_planet` | trigger | `o(1)` | CCanLiveOnPlanetTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_lock_be_renewed` | trigger | `o(1)` | CCanLockBeRenewed::ActualEvaluate (no scan in the command or its direct callees) |
| `can_research_technology` | trigger | `o(1)` | CCanResearchTechnologyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_spawn_random_anomaly` | trigger | `o(1)` | CCanSpawnRandomAnomalyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `can_work_specific_job` | trigger | `o(1)` | CCanWorkSpecificJobTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `cancel_terraformation` | effect | `o(1)` | CCancelTerraformationCommand::Execute (no scan in the command or its direct callees) |
| `capital_tier` | trigger | `o(1)` | CCapitalTierTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `carrier_is_type` | trigger | `o(1)` | CCarrierIsTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `category_last_picked_tradition` | trigger | `o(1)` | CCategoryLastPickedTraditionTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `ceiling_variable` | effect | `o(1)` | CCeilingVariableEffect::GetValue (no scan in the command or its direct callees) |
| `change_background_ethic` | effect | `o(1)` | CChangeBackgroundEthic::ExecuteActual (no scan in the command or its direct callees) |
| `change_background_job` | effect | `o(1)` | CChangeBackgroundJob::ExecuteActual (no scan in the command or its direct callees) |
| `change_colony_foundation_date` | effect | `o(1)` | CChangeColonyFoundationDateEffect::ExecuteActual (no scan in the command or its direct callees) |
| `change_planet_size` | effect | `o(1)` | CChangePlanetSizeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `change_situation_target` | effect | `o(1)` | CChangeSituationTargetEffect::ExecuteActual (no scan in the command or its direct callees) |
| `change_variable` | effect | `o(1)` | CChangeVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `check_galaxy_setup_value` | trigger | `o(1)` | CCheckGalaxySetupValueTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `check_planet_employment` | effect | `o(1)` | CCheckPlanetEmploymentEffect::ExecuteActual (no scan in the command or its direct callees) |
| `check_variable` | trigger | `o(1)` | CCheckVariableTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `civics_count` | trigger | `o(1)` | CCivicsCount::GetTriggerValue (no scan in the command or its direct callees) |
| `clear_blocker` | effect | `o(1)` | CClearBlockerEffect::ExecuteActual (no scan in the command or its direct callees) |
| `clear_fleet_actions` | effect | `o(1)` | CClearFleetActionsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `clear_planet_purge_type` | effect | `o(1)` | CClearPlanetPurgeTypeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `clear_relations` | effect | `o(1)` | CClearRelationsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `clear_variable` | effect | `o(1)` | CClearVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `colony_age` | trigger | `o(1)` | CColonyAgeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `colony_age_years` | trigger | `o(1)` | CColonyAgeYearsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `compare_distance` | trigger | `o(1)` | CCompareDistanceTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `controlled_systems` | trigger | `o(1)` | CControlledSystems::GetTriggerValue (no scan in the command or its direct callees) |
| `cosmic_storm_system_influence` | trigger | `o(1)` | CCosmicStormSystemInfluenceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `count_tech_options` | trigger | `o(1)` | CCountTechOptionsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `create_archaeological_site` | effect | `o(1)` | CCreateArchaeologicalSiteEffect::ExecuteActual (no scan in the command or its direct callees) |
| `create_cluster` | effect | `o(1)` | CCreateClusterEffect::ExecuteActual (no scan in the command or its direct callees) |
| `create_cosmic_storm` | effect | `o(1)` | CCreateCosmicStormEffect::ExecuteActual (no scan in the command or its direct callees) |
| `create_leader` | effect | `o(1)` | CCreateLeader::ExecuteActual (no scan in the command or its direct callees) |
| `create_patron_relation` | effect | `o(1)` | CCreatePatronRelationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `create_point_of_interest` | effect | `o(1)` | CCreatePointOfInterestEffect::ExecuteActual (no scan in the command or its direct callees) |
| `create_sector` | effect | `o(1)` | CCreateSectorEffect::ExecuteActual (no scan in the command or its direct callees) |
| `current_stage` | trigger | `o(1)` | CCurrentStageTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `damage_army` | effect | `o(1)` | CDamageArmyEffect::ExecuteActual (no scan in the command or its direct callees) |
| `days_passed` | trigger | `o(1)` | CDaysPassedTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `debug_break` | trigger | `o(1)` | CDebugBreakTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `debug_break` | effect | `o(1)` | CDebugBreakEffect::ExecuteActual (no scan in the command or its direct callees) |
| `decrease_council_size` | effect | `o(1)` | CDecreaseCouncilSizeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `destroy_astral_rift` | effect | `o(1)` | CDestroyAstralRiftEffect::ExecuteActual (no scan in the command or its direct callees) |
| `destroy_colony` | effect | `o(1)` | CDestroyColonyEffect::ExecuteActual (no scan in the command or its direct callees) |
| `destroy_cosmic_storm` | effect | `o(1)` | CDestroyCosmicStormEffect::ExecuteActual (no scan in the command or its direct callees) |
| `destroy_country` | effect | `o(1)` | CDestroyCountryEffect::ExecuteActual (no scan in the command or its direct callees) |
| `diplomacy_weight` | trigger | `o(1)` | CDiplomacyWeightTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `dissolve_federation` | effect | `o(1)` | CDissolveFederationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `distance_to_capital` | trigger | `o(1)` | CDistanceToCapitalTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `empire_size` | trigger | `o(1)` | CEmpireSizeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `enable_galactic_market` | effect | `o(1)` | CEnableGalacticMarketEffect::ExecuteActual (no scan in the command or its direct callees) |
| `enable_mission` | effect | `o(1)` | CEnableMissionEffect::ExecuteActual (no scan in the command or its direct callees) |
| `enable_on_market` | effect | `o(1)` | CEnableOnMarketEffect::ExecuteActual (no scan in the command or its direct callees) |
| `enable_patron_first_contact_project` | effect | `o(1)` | CEnablePatronFirstContactProjectEffect::ExecuteActual (no scan in the command or its direct callees) |
| `enable_special_project` | effect | `o(1)` | CEnableSpecialProjectEffect::ExecuteActual (no scan in the command or its direct callees) |
| `end_all_treaties_with` | effect | `o(1)` | CEndAllTreatiesWithEffect::ExecuteActual (no scan in the command or its direct callees) |
| `end_game_years_passed` | trigger | `o(1)` | CEndGameYearsPassedTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `end_truce` | effect | `o(1)` | CEndTruceEffect::ExecuteActual (no scan in the command or its direct callees) |
| `envoy_opinion_change` | trigger | `o(1)` | CEnvoyOpinionChangeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `expenses` | trigger | `o(1)` | CExpensesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `export_trigger_value_to_variable` | effect | `o(1)` | CExportTriggerValueToVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `federation_cohesion` | trigger | `o(1)` | CFederationCohesionTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `federation_experience` | trigger | `o(1)` | CFederationExperienceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `federation_level` | trigger | `o(1)` | CFederationLevelTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `finish_council_agenda` | effect | `o(1)` | CFinishCouncilAgendaEffect::ExecuteActual (no scan in the command or its direct callees) |
| `finish_terraformation` | effect | `o(1)` | CFinishTerraformationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `finish_upgrade` | effect | `o(1)` | CFinishUpgradeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `fleet_size` | trigger | `o(1)` | CFleetSizeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `floor_variable` | effect | `o(1)` | CFloorVariableEffect::GetValue (no scan in the command or its direct callees) |
| `force_faction_evaluation` | effect | `o(1)` | CForceFactionEvaluationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `free_amenities` | trigger | `o(1)` | CFreeAmenitiesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `free_housing` | trigger | `o(1)` | CFreeHousingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `freeze_leader_age` | effect | `o(1)` | CFreezeLeaderAgeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `galactic_defense_force_exists` | trigger | `o(1)` | CGalacticDefenseForceExistsTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `galaxy_percentage` | trigger | `o(1)` | CGalaxyPercentageTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `galaxy_radius` | trigger | `o(1)` | CGalaxyRadiusTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `galaxy_shape` | trigger | `o(1)` | CGalaxyShapeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `galaxy_size` | trigger | `o(1)` | CGalaxySizeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `get_galaxy_setup_value` | effect | `o(1)` | CGetGalaxySetupValueEffect::ExecuteActual (no scan in the command or its direct callees) |
| `go_to_next_pre_ftl_age` | effect | `o(1)` | CGoToNextPreFtlAgeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `guarantee_country` | effect | `o(1)` | CGuaranteeCountryEffect::ExecuteActual (no scan in the command or its direct callees) |
| `happiness` | trigger | `o(1)` | CHappinessTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `has_active_specialization` | trigger | `o(1)` | CHasActiveSpecializationTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_agenda_selected` | trigger | `o(1)` | CHasAgendaSelected::ActualEvaluate (no scan in the command or its direct callees) |
| `has_anomaly` | trigger | `o(1)` | CHasAnomalyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_any_federation_law_in_category` | trigger | `o(1)` | CHasAnyFederationLawInCategoryTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_any_flag` | trigger | `o(1)` | CHasAnyFlagTrigger::ActualEvaluate count-only check; dump L6773813 (test at L6773819) |
| `has_any_overlord` | trigger | `o(1)` | CHasAnyOverlord::ActualEvaluate (no scan in the command or its direct callees) |
| `has_armor_percentage` | trigger | `o(1)` | CHasArmorPercentageTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `has_army` | trigger | `o(1)` | CHasArmyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_association_status` | trigger | `o(1)` | CHasAssociationStatusPactTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_asteroid_belt` | trigger | `o(1)` | CHasAsteroidBeltTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_astral_rift` | trigger | `o(1)` | CHasAstralRiftTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_auto_move_target` | trigger | `o(1)` | CHasAutoMoveTargetTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_background_job` | trigger | `o(1)` | CHasBackgroundJobTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_base_skill` | trigger | `o(1)` | CHasBaseSkill::GetTriggerValue (no scan in the command or its direct callees) |
| `has_built_species` | trigger | `o(1)` | CHasBuiltSpecies::ActualEvaluate (no scan in the command or its direct callees) |
| `has_citizenship_rights` | trigger | `o(1)` | CHasCitizenshipRightsTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_civic_in_slot` | trigger | `o(1)` | CHasCivicInSlotTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_civilian_job_category` | trigger | `o(1)` | CHasCivilianJobCategory::ActualEvaluate (no scan in the command or its direct callees) |
| `has_cloaking_strength` | trigger | `o(1)` | CHasCloakingStrengthValueTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `has_commercial_pact` | trigger | `o(1)` | CHasCommercialPactTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_communications` | trigger | `o(1)` | CHasCommunicationsTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_covenant` | trigger | `o(1)` | CHasCovenantTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_crisis_level` | trigger | `o(1)` | CHasCrisisLevelTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_crisis_perk` | trigger | `o(1)` | CHasCrisisPerkTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_defensive_pact` | trigger | `o(1)` | CHasDefensivePactTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_deficit` | trigger | `o(1)` | CHasDeficitTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_deposit_category` | trigger | `o(1)` | CHasDepositCategoryTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_deposit_for` | trigger | `o(1)` | CHasDepositForTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_diplo_migration_treaty` | trigger | `o(1)` | CHasDiploMigrationTreatyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_embassy` | trigger | `o(1)` | CHasEmbassyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_envoy_cooldown` | trigger | `o(1)` | CHasEnvoyCooldownTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_established_contact` | trigger | `o(1)` | CHasEstablishedContactTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_experience` | trigger | `o(1)` | CHasExperience::GetTriggerValue (no scan in the command or its direct callees) |
| `has_federation` | trigger | `o(1)` | CHasFederationTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_federation_law` | trigger | `o(1)` | CHasFederationLawTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_federation_setting` | trigger | `o(1)` | CHasFederationSetting::ActualEvaluate (no scan in the command or its direct callees) |
| `has_federation_type` | trigger | `o(1)` | CHasFederationTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_galactic_custodian` | trigger | `o(1)` | CHasGalacticCustodianTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_galactic_emperor` | trigger | `o(1)` | CHasGalacticEmperorTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_government` | trigger | `o(1)` | CHasGovernmentTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_ground_combat` | trigger | `o(1)` | CHasGroundCombat::ActualEvaluate (no scan in the command or its direct callees) |
| `has_job_category` | trigger | `o(1)` | CHasJobCategory::ActualEvaluate (no scan in the command or its direct callees) |
| `has_job_type` | trigger | `o(1)` | CHasJobType::ActualEvaluate (no scan in the command or its direct callees) |
| `has_loyalty` | trigger | `o(1)` | CHasLoyaltyTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `has_migration_access` | trigger | `o(1)` | CHasMigrationAccessTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_mining_station` | trigger | `o(1)` | CHasMiningStationTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_mission` | trigger | `o(1)` | CHasMission::ActualEvaluate (no scan in the command or its direct callees) |
| `has_monthly_income` | trigger | `o(1)` | CHasMonthlyIncomeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_moon` | trigger | `o(1)` | CHasMoonTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_next_pre_ftl_age` | trigger | `o(1)` | CHasNextPreFtlAge::ActualEvaluate (no scan in the command or its direct callees) |
| `has_non_aggression_pact` | trigger | `o(1)` | CHasNonAggressionPactTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_observation_outpost` | trigger | `o(1)` | CHasObservationOutpostTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_opinion_modifier` | trigger | `o(1)` | CHasOpinionModifier::ActualEvaluate (no scan in the command or its direct callees) |
| `has_orbital_bombardment` | trigger | `o(1)` | CHasOrbitalBombardmentTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_orbital_station` | trigger | `o(1)` | CHasOrbitalStationTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_origin` | trigger | `o(1)` | CHasOriginTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_overclock` | trigger | `o(1)` | CHasOverclockTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_overclock_cooldown` | trigger | `o(1)` | CHasOverclockCooldownTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_overlord` | trigger | `o(1)` | CHasOverlord::ActualEvaluate (no scan in the command or its direct callees) |
| `has_owner` | trigger | `o(1)` | CHasOwnerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_patron_aura` | trigger | `o(1)` | CHasPatronAuraTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_picked_auto_mod_habitability` | trigger | `o(1)` | CHasPickedAutoModHabitabilityTrait::ActualEvaluate (no scan in the command or its direct callees) |
| `has_planetary_ascension_tier` | trigger | `o(1)` | CHasPlanetaryAscensionTierTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `has_pre_ftl_age` | trigger | `o(1)` | CHasPreFtlAge::ActualEvaluate (no scan in the command or its direct callees) |
| `has_pre_ftl_trade` | trigger | `o(1)` | CHasPreFtlTradeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_research_agreement` | trigger | `o(1)` | CHasResearchAgreementTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_research_station` | trigger | `o(1)` | CHasResearchStationTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_ring` | trigger | `o(1)` | CHasRingTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_role` | trigger | `o(1)` | CHasRoleTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_same_ethos` | trigger | `o(1)` | CHasSameEthosTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_secret_fealty_with` | trigger | `o(1)` | CHasSecretFealtyWithTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_sector_type` | trigger | `o(1)` | CHasSectorTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_shield_percentage` | trigger | `o(1)` | CHasShieldPercentageTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `has_ship_owner_type` | trigger | `o(1)` | CHasShipOwnerType::ActualEvaluate (no scan in the command or its direct callees) |
| `has_subject` | trigger | `o(1)` | CHasSubject::ActualEvaluate (no scan in the command or its direct callees) |
| `has_technology` | trigger | `o(1)` | CTechnologyStatus::HasTechnology indexes the status array by tech id; dump L1504242 (no loop) |
| `has_total_skill` | trigger | `o(1)` | CHasTotalSkill::GetTriggerValue (no scan in the command or its direct callees) |
| `has_truce` | trigger | `o(1)` | CHasTruceTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `has_unlocked_council_positions` | trigger | `o(1)` | CHasUnlockedCouncilPositions::GetTriggerValue (no scan in the command or its direct callees) |
| `has_waystation_pact` | trigger | `o(1)` | CHasWaystationPactTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `imperial_authority` | trigger | `o(1)` | CImperialAuthorityTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `in_breach_of` | trigger | `o(1)` | CInBreachOfTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `income` | trigger | `o(1)` | CIncomeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `increase_council_size` | effect | `o(1)` | CIncreaseCouncilSizeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `inherits_parent_rights` | trigger | `o(1)` | CInheritsParentRights::ActualEvaluate (no scan in the command or its direct callees) |
| `inner_radius` | trigger | `o(1)` | CInnerRadiusTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `intel_level` | trigger | `o(1)` | CIntelLevelTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_alliance_fleet` | trigger | `o(1)` | CIsAllianceFleet::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ambient_object_type` | trigger | `o(1)` | CIsAmbientObjectTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_archetype` | trigger | `o(1)` | CIsArchetypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_army` | trigger | `o(1)` | CIsArmyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_asteroid` | trigger | `o(1)` | CIsAsteroidTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_astral_scar` | trigger | `o(1)` | CIsAstralScarTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_at_war` | trigger | `o(1)` | CIsAtWar::ActualEvaluate (no scan in the command or its direct callees) |
| `is_at_war_with` | trigger | `o(1)` | CIsAtWarWithTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_background_planet` | trigger | `o(1)` | CIsBackgroundPlanet::ActualEvaluate (no scan in the command or its direct callees) |
| `is_blocker` | trigger | `o(1)` | CIsBlockerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_bridge` | trigger | `o(1)` | CIsBridgeSystemTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_bypass_type` | trigger | `o(1)` | CIsBypassTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_capital` | trigger | `o(1)` | CIsCapital::ActualEvaluate (no scan in the command or its direct callees) |
| `is_capital_system` | trigger | `o(1)` | CIsCapitalSystem::ActualEvaluate (no scan in the command or its direct callees) |
| `is_civilian` | trigger | `o(1)` | CIsCivilianTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_cloaked` | trigger | `o(1)` | CIsCloakedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_colonizable` | trigger | `o(1)` | CIsColonizableTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_colony` | trigger | `o(1)` | CIsColonyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_constructing` | trigger | `o(1)` | CIsConstructingTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_controlled_by` | trigger | `o(1)` | CIsControlledByTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_councilor` | trigger | `o(1)` | CIsCouncilorTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_counter_espionage` | trigger | `o(1)` | CIsCounterEspionageTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_country` | trigger | `o(1)` | CIsCountryTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_country_type` | trigger | `o(1)` | CIsCountryTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_criminal_syndicate` | trigger | `o(1)` | CIsCriminalSyndicateTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_crises_allowed` | trigger | `o(1)` | CIsCrisesAllowedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_current_first_contact_stage` | trigger | `o(1)` | CIsCurrentFirstContactStageTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_damaged` | trigger | `o(1)` | CIsDamagedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_defensive_army` | trigger | `o(1)` | CIsDefensiveArmyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_difficulty` | trigger | `o(1)` | CIsDifficultyTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_disabled` | trigger | `o(1)` | CIsDisabledTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_espionage_operation_chapter` | trigger | `o(1)` | CIsEspionageOperationChapterTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_espionage_operation_days_to_next_die_roll` | trigger | `o(1)` | CIsEspionageOperationDaysToNextDieRollTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_espionage_operation_difficulty` | trigger | `o(1)` | CIsEspionageOperationDifficultyTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_espionage_operation_score` | trigger | `o(1)` | CIsEspionageOperationScoreTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_exhibit_active` | trigger | `o(1)` | CIsExhibitActive::ActualEvaluate (no scan in the command or its direct callees) |
| `is_faction_extorted` | trigger | `o(1)` | CIsFactionExtorted::ActualEvaluate (no scan in the command or its direct callees) |
| `is_federation_leader` | trigger | `o(1)` | CIsFederationLeaderTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_from_proxy_war` | trigger | `o(1)` | CIsFromProxyWarTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_galactic_community_formed` | trigger | `o(1)` | CIsGalacticCommunityFormedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_galactic_council_established` | trigger | `o(1)` | CIsGalacticCouncilEstablishedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_galactic_custodian` | trigger | `o(1)` | CIsGalacticCustodianTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_galactic_emperor` | trigger | `o(1)` | CIsGalacticEmperorTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_garrison` | trigger | `o(1)` | CIsGarrisonTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_growth_complete` | trigger | `o(1)` | CIsGrowthComplete::ActualEvaluate (no scan in the command or its direct callees) |
| `is_guaranteeing` | trigger | `o(1)` | CIsGuaranteeingTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_heir` | trigger | `o(1)` | CIsHeirTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_homeworld` | trigger | `o(1)` | CIsHomeworld::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ideal` | trigger | `o(1)` | CIsIdealTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_idle` | trigger | `o(1)` | CIsIdleTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_in_breach_of_any` | trigger | `o(1)` | CIsInBreachOfAnyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_in_combat` | trigger | `o(1)` | CIsInCombatTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_in_frontier_space` | trigger | `o(1)` | CIsInFrontierSpace::ActualEvaluate (no scan in the command or its direct callees) |
| `is_in_frontline` | trigger | `o(1)` | CIsInFrontlineTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_inside_nebula` | trigger | `o(1)` | CIsInsideNebula::ActualEvaluate (no scan in the command or its direct callees) |
| `is_inside_storm` | trigger | `o(1)` | CIsInsideStormTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ironman` | trigger | `o(1)` | CIsIronmanTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_job_of_pop_category` | trigger | `o(1)` | CIsJobOfPopCategoryTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_acquired_specimen` | trigger | `o(1)` | CIsLastAcquiredSpecimen::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_acquired_specimen_from_trade` | trigger | `o(1)` | CIsLastAcquiredSpecimenFromTrade::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_acquired_specimen_rarity` | trigger | `o(1)` | CIsLastAcquiredSpecimenRarity::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_building_changed_capital` | trigger | `o(1)` | CIsLastBuildingChangedCapitalTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_increased_tech_rare` | trigger | `o(1)` | CIsLastIncreasedTechRare::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_increased_tech_repeatable` | trigger | `o(1)` | CIsLastIncreasedTechRepeatable::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_lost_relic` | trigger | `o(1)` | CIsLastLostRelic::ActualEvaluate (no scan in the command or its direct callees) |
| `is_last_received_relic` | trigger | `o(1)` | CIsLastReceivedRelic::ActualEvaluate (no scan in the command or its direct callees) |
| `is_leader_tier` | trigger | `o(1)` | CIsLeaderTier::ActualEvaluate (no scan in the command or its direct callees) |
| `is_leased` | trigger | `o(1)` | CIsLeasedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_market_leader` | trigger | `o(1)` | CIsMarketLeader::ActualEvaluate (no scan in the command or its direct callees) |
| `is_mission_type` | trigger | `o(1)` | CIsMissionTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_mobile` | trigger | `o(1)` | CIsMobileTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_moon` | trigger | `o(1)` | CIsMoonTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_multiplayer` | trigger | `o(1)` | CIsMultiplayerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_nomadic` | trigger | `o(1)` | CIsNomadicTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_on_galaxy_map` | trigger | `o(1)` | CIsOnGalaxyMapTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_on_market` | trigger | `o(1)` | CIsOnMarketTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_orbiting_star` | trigger | `o(1)` | CIsOrbitingStarTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_original_owner` | trigger | `o(1)` | CIsOriginalOwnerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_overlord` | trigger | `o(1)` | CIsOverlordTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_paused` | trigger | `o(1)` | CIsPausedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_pirate` | trigger | `o(1)` | CIsPirateTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_planet` | trigger | `o(1)` | CIsPlanetTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_pop_category` | trigger | `o(1)` | CIsPopCategory::ActualEvaluate (no scan in the command or its direct callees) |
| `is_preferred_patron` | trigger | `o(1)` | CIsPreferredPatronTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_preventing_anomaly` | trigger | `o(1)` | CIsPreventingAnomalyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_primary_star` | trigger | `o(1)` | CIsPrimaryStarTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_primitive` | trigger | `o(1)` | CIsPrimitive::ActualEvaluate (no scan in the command or its direct callees) |
| `is_reanimated` | trigger | `o(1)` | CIsReanimatedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ringworld` | trigger | `o(1)` | CIsRingworldTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_robot_pop` | trigger | `o(1)` | CIsRobotPop::ActualEvaluate (no scan in the command or its direct callees) |
| `is_robot_pop_group` | trigger | `o(1)` | CIsRobotPopGroup::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ruler` | trigger | `o(1)` | CIsRulerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_same_empire` | trigger | `o(1)` | CIsSameEmpireTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_same_species` | trigger | `o(1)` | CIsSameSpeciesBase::ActualEvaluate (no scan in the command or its direct callees) |
| `is_same_species_class` | trigger | `o(1)` | CIsSameSpeciesClassTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_same_value` | trigger | `o(1)` | CIsSameValueTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_sapient` | trigger | `o(1)` | CIsSapient::ActualEvaluate (no scan in the command or its direct callees) |
| `is_scope_set` | trigger | `o(1)` | CIsScopeSetTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_scope_type` | trigger | `o(1)` | CIsScopeTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_scope_valid` | trigger | `o(1)` | CIsScopeValidTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_scripted_terraforming` | trigger | `o(1)` | CIsScriptedTerraformingTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_sector_capital` | trigger | `o(1)` | CIsSectorCapitalTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ship` | trigger | `o(1)` | CIsShipTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ship_category` | trigger | `o(1)` | CIsShipCategoryTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_ship_class` | trigger | `o(1)` | CIsShipClassTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_space_fauna` | trigger | `o(1)` | CIsSpaceFaunaTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_species_class` | trigger | `o(1)` | CIsSpeciesClass::ActualEvaluate (no scan in the command or its direct callees) |
| `is_specimen_category` | trigger | `o(1)` | CIsSpecimenCategory::ActualEvaluate (no scan in the command or its direct callees) |
| `is_specimen_rarity` | trigger | `o(1)` | CIsSpecimenRarity::ActualEvaluate (no scan in the command or its direct callees) |
| `is_star` | trigger | `o(1)` | CIsStarTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_starbase_type` | trigger | `o(1)` | CIsStarbaseTypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_storm_active_in_storm_sector` | trigger | `o(1)` | CIsStormActiveInStormSectorTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_storm_type` | trigger | `o(1)` | CIsStormType::ActualEvaluate (no scan in the command or its direct callees) |
| `is_subject` | trigger | `o(1)` | CIsSubjectTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_subspecies` | trigger | `o(1)` | CIsSubspeciesTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_terraformed` | trigger | `o(1)` | CIsTerraformedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_terraforming` | trigger | `o(1)` | CIsTerraformingTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_under_colonization` | trigger | `o(1)` | CIsUnderColonizationTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_under_open_technological_enlightenment` | trigger | `o(1)` | CIsUnderOpenTechnologicalEnlightenmentTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_under_societal_enlightenment` | trigger | `o(1)` | CIsUnderSocietalEnlightenmentTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_under_stratified_technological_enlightenment` | trigger | `o(1)` | CIsUnderStratifiedTechnologicalEnlightenmentTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_unemployed` | trigger | `o(1)` | CIsUnemployed::ActualEvaluate (no scan in the command or its direct callees) |
| `is_upgrading` | trigger | `o(1)` | CIsUpgradingTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_valid` | trigger | `o(1)` | CIsValidTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_variable_set` | trigger | `o(1)` | CIsVariableSetTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_voting_on_resolution` | trigger | `o(1)` | CIsVotingOnResolutionTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_war_leader` | trigger | `o(1)` | CIsWarLeaderTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_within_borders_of` | trigger | `o(1)` | CIsWithinBordersOfTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `is_years_since_community_formation` | trigger | `o(1)` | CIsYearsSinceCommunityFormationTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `is_years_since_council_establishment` | trigger | `o(1)` | CIsYearsSinceCouncilEstablishmentTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `last_activated_relic` | trigger | `o(1)` | CLastActivatedRelic::ActualEvaluate (no scan in the command or its direct callees) |
| `last_changed_policy` | trigger | `o(1)` | CLastChangedPolicyTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `last_increased_tech` | trigger | `o(1)` | CLastIncreasedTechTrigger::ActualEvaluate is one cached-pointer compare; dump L6862648 |
| `last_lost_relic` | trigger | `o(1)` | CLastLostRelic::ActualEvaluate (no scan in the command or its direct callees) |
| `last_received_relic` | trigger | `o(1)` | CLastReceivedRelic::ActualEvaluate (no scan in the command or its direct callees) |
| `last_resolution_category_changed` | trigger | `o(1)` | CLastResolutionCategoryChangedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `last_resolution_changed` | trigger | `o(1)` | CLastResolutionChangedTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `leader_age` | trigger | `o(1)` | CLeaderAgeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `leader_class` | trigger | `o(1)` | CLeaderClassTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `leader_years_of_service` | trigger | `o(1)` | CLeaderYearsOfServiceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `link_to` | effect | `o(1)` | CLinkToEffect::ExecuteActual (no scan in the command or its direct callees) |
| `lock_bypass` | effect | `o(1)` | CLockBypassEffect::ExecuteActual (no scan in the command or its direct callees) |
| `log` | trigger | `o(1)` | CLogTrigger::ActualEvaluate; dump L6880834 (no container scan) |
| `log` | effect | `o(1)` | CLogEffect::ExecuteActual; dump L6035532 (no container scan) |
| `logged_in_to_pdx_account` | trigger | `o(1)` | CLoggedInToPdxAccountTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `market_resource_price` | trigger | `o(1)` | CMarketResourcePriceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `max_starbase_capacity` | trigger | `o(1)` | CMaxStarbaseCapacityTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `member_of_faction` | trigger | `o(1)` | CMemberOfFactionTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `mid_game_years_passed` | trigger | `o(1)` | CMidGameYearsPassedTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `mission_progress` | trigger | `o(1)` | CMissionProgressTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `modulo_variable` | effect | `o(1)` | CModuloVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `multiply_crisis_strength` | effect | `o(1)` | CMultiplyCrisisStrengthEffect::ExecuteActual (no scan in the command or its direct callees) |
| `multiply_variable` | effect | `o(1)` | CMultiplyVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `must_research` | trigger | `o(1)` | CMustResearchDebrisTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `must_scavenge` | trigger | `o(1)` | CMustScavengeDebrisTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `num_armies` | trigger | `o(1)` | CNumArmiesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_ascension_perks` | trigger | `o(1)` | CNumAscensionPerksTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_associates` | trigger | `o(1)` | CNumAssociatesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_asteroid_belts` | trigger | `o(1)` | CNumAsteroidBeltsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_early_game_spawn_chance_scale_setting` | trigger | `o(1)` | CNumCosmicStormEarlyGameSpawnChanceScaleSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_early_game_spawn_max_cap_setting` | trigger | `o(1)` | CNumCosmicStormEarlyGameSpawnMaxCapSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_late_game_spawn_chance_scale_setting` | trigger | `o(1)` | CNumCosmicStormLateGameSpawnChanceScaleSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_late_game_spawn_max_cap_setting` | trigger | `o(1)` | CNumCosmicStormLateGameSpawnMaxCapSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_mid_game_spawn_chance_scale_setting` | trigger | `o(1)` | CNumCosmicStormMidGameSpawnChanceScaleSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_mid_game_spawn_max_cap_setting` | trigger | `o(1)` | CNumCosmicStormMidGameSpawnMaxCapSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storm_spawn_cooldown_scale_setting` | trigger | `o(1)` | CNumCosmicStormSpawnCooldownScaleSetting::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storms` | trigger | `o(1)` | CNumCosmicStormsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_cosmic_storms_encountered` | trigger | `o(1)` | CNumCosmicStormsEncountered::GetTriggerValue (no scan in the command or its direct callees) |
| `num_council_positions` | trigger | `o(1)` | CNumCouncilPositionsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_deposits` | trigger | `o(1)` | CNumDepositsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_ethics` | trigger | `o(1)` | CNumEthicsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_fallen_empires_setting` | trigger | `o(1)` | CNumFallenEmpiresSettingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_favors` | trigger | `o(1)` | CNumFavorsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_fleets` | trigger | `o(1)` | CNumFleetsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_galaxy_systems` | trigger | `o(1)` | CNumGalaxySystemsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_guaranteed_colonies` | trigger | `o(1)` | CNumGuaranteedColoniesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_housing` | trigger | `o(1)` | CNumHousingTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_killed_ships` | trigger | `o(1)` | CNumKilledShipsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_marauder_empires_to_spawn` | trigger | `o(1)` | CNumMarauderEmpiresToSpawnTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_members` | trigger | `o(1)` | CNumMembersTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_modifiers` | trigger | `o(1)` | CNumModifiersTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_moons` | trigger | `o(1)` | CNumMoonsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_owned_colonies` | trigger | `o(1)` | CNumOwnedColoniesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_owned_relics` | trigger | `o(1)` | CNumOwnedRelics::GetTriggerValue (no scan in the command or its direct callees) |
| `num_sectors` | trigger | `o(1)` | CNumSectorsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_species` | trigger | `o(1)` | CNumSpeciesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_taken_planets` | trigger | `o(1)` | CNumTakenPlanetsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_tradition_categories` | trigger | `o(1)` | CNumTraditionCategoriesTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_traits` | trigger | `o(1)` | CNumTraitsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `num_unique_cosmic_storms_encountered` | trigger | `o(1)` | CNumUniqueCosmicStormsEncountered::GetTriggerValue (no scan in the command or its direct callees) |
| `opinion` | trigger | `o(1)` | COpinionTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `opinion_level` | trigger | `o(1)` | COpinionLevelTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `original_owner` | trigger | `o(1)` | COriginalOwnerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `planet_devastation` | trigger | `o(1)` | CPlanetDevastationTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `planet_size` | trigger | `o(1)` | CPlanetSizeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `pop_group_has_happiness` | trigger | `o(1)` | CPopGroupHasHappinessTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `pop_group_size` | trigger | `o(1)` | CPopGroupSizeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `pop_maintenance_cost` | trigger | `o(1)` | CPopMaintenanceCostTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `prevent_anomaly` | effect | `o(1)` | CPreventAnomalyEffect::ExecuteActual (no scan in the command or its direct callees) |
| `randomize_flag_symbol` | effect | `o(1)` | CRandomizeFlagSymbolEffect::ExecuteActual (no scan in the command or its direct callees) |
| `recently_lost_war` | trigger | `o(1)` | CRecentlyLostWarTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `refresh_portraits` | effect | `o(1)` | CRefreshPortraits::ExecuteActual (no scan in the command or its direct callees) |
| `relative_power` | trigger | `o(1)` | CRelativePowerTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `remove_deposit` | effect | `o(1)` | CRemoveDepositEffect::ExecuteActual (no scan in the command or its direct callees) |
| `remove_favors` | effect | `o(1)` | CRemoveFavorsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `remove_holding` | effect | `o(1)` | CRemoveHoldingEffect::ExecuteActual (no scan in the command or its direct callees) |
| `remove_opinion_modifier` | effect | `o(1)` | CRemoveOpinionModifierEffect::ExecuteActual (no scan in the command or its direct callees) |
| `remove_planet` | effect | `o(1)` | CRemovePlanetEffect::ExecuteActual (no scan in the command or its direct callees) |
| `remove_pop_amount` | effect | `o(1)` | CRemovePopAmountEffect::ExecuteActual (no scan in the command or its direct callees) |
| `remove_secret_fealty` | effect | `o(1)` | CRemoveSecretFealtyEffect::ExecuteActual (no scan in the command or its direct callees) |
| `repair_ship` | effect | `o(1)` | CRepairShipEffect::ExecuteActual (no scan in the command or its direct callees) |
| `replace_patron` | effect | `o(1)` | CReplacePatronEffect::ExecuteActual (no scan in the command or its direct callees) |
| `reroll_planet_modifiers` | effect | `o(1)` | CRerollPlanetModifiersEffect::ExecuteActual (no scan in the command or its direct callees) |
| `reroll_random` | effect | `o(1)` | CRerollRandomEffect::ExecuteActual (no scan in the command or its direct callees) |
| `reset_years_of_peace` | effect | `o(1)` | CResetYearsOfPeace::ExecuteActual (no scan in the command or its direct callees) |
| `resource_stockpile_percent` | trigger | `o(1)` | CResourceStockpilePercentTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `restore_country_backup_data` | effect | `o(1)` | CRestoreCountryBackupDataEffect::ExecuteActual (no scan in the command or its direct callees) |
| `room_name_override` | effect | `o(1)` | CRoomNameOverrideEffect::ExecuteActual (no scan in the command or its direct callees) |
| `round_variable` | effect | `o(1)` | CRoundVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `round_variable_to_closest` | effect | `o(1)` | CRoundVariableToClosestEffect::ExecuteActual (no scan in the command or its direct callees) |
| `running_balance` | trigger | `o(1)` | CRunningBalanceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `scale_pop_amount` | effect | `o(1)` | CScalePopAmountEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_aggro_range` | effect | `o(1)` | CSetAggroRangeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_animation_state` | effect | `o(1)` | CSetAnimationStateEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_auto_upgrade_components` | effect | `o(1)` | CSetAutoUpgradeComponents::ExecuteActual (no scan in the command or its direct callees) |
| `set_awareness` | effect | `o(1)` | CSetAwarenessEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_built_species` | effect | `o(1)` | CSetBuiltSpeciesEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_capital` | effect | `o(1)` | CSetCapitalEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_city_graphical_culture` | effect | `o(1)` | CSetCityGraphicalCultureEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_cloaking_active` | effect | `o(1)` | CSetCloakingActiveEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_closed_borders` | effect | `o(1)` | CSetClosedBordersEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_colony_type` | effect | `o(1)` | CSetColonyTypeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_cooldown` | effect | `o(1)` | CSetCooldownEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_cosmic_storm` | effect | `o(1)` | CSetCosmicStormEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_council_agenda` | effect | `o(1)` | CSetCouncilAgendaEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_council_emergency_measures` | effect | `o(1)` | CSetCouncilEmergencyMeasuresEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_council_size` | effect | `o(1)` | CSetCouncilSizeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_council_veto` | effect | `o(1)` | CSetCouncilVetoEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_crisis_sound` | effect | `o(1)` | CSetCrisisSoundEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_custodian_term_days` | effect | `o(1)` | CSetCustodianTermDaysEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_custom_capital_location` | effect | `o(1)` | CSetCustomCapitalLocationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_diplomacy_action_setting` | effect | `o(1)` | CSetDiplomacyActionSettingEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_disabled` | effect | `o(1)` | CSetDisabledEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_emergency_fund_active` | effect | `o(1)` | CSetEmergencyFundActiveEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_emergency_fund_contribution_rate` | effect | `o(1)` | CSetEmergencyFundContributionRateEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_emperor_can_change_council_members` | effect | `o(1)` | CSetEmperorCanChangeCouncilMembersEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_espionage_operation_progress_locked` | effect | `o(1)` | CSetEspionageOperationProgressLockedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_event_locked` | effect | `o(1)` | CSetEventLockedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_federation_law` | effect | `o(1)` | CSetFederationLawEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_federation_succession_term` | effect | `o(1)` | CSetFederationSuccessionTermEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_federation_succession_type` | effect | `o(1)` | CSetFederationSuccessionTypeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_fleet_bombardment_stance` | effect | `o(1)` | CSetFleetBombardmentStanceEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_fleet_formation` | effect | `o(1)` | CSetFleetFormationEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_fleet_settings` | effect | `o(1)` | CSetFleetSettingsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_fleet_stance` | effect | `o(1)` | CSetFleetStanceEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_galactic_custodian` | effect | `o(1)` | CSetGalacticCustodianEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_gender` | effect | `o(1)` | CSetGenderEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_government_cooldown` | effect | `o(1)` | CSetGovernmentCooldownEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_halted` | effect | `o(1)` | CSetHaltedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_heir` | effect | `o(1)` | CSetHeirEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_immortal` | effect | `o(1)` | CSetImmortalEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_leader_tier` | effect | `o(1)` | CSetLeaderTierEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_market_leader` | effect | `o(1)` | CSetMarketLeaderEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_next_astral_rift_event` | effect | `o(1)` | CSetNextAstralRiftEventEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_planet_entity` | effect | `o(1)` | CSetPlanetEntityEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_planet_purge_type` | effect | `o(1)` | CSetPlanetPurgeTypeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_planet_size` | effect | `o(1)` | CSetPlanetSizeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_planetary_ascension_tier` | effect | `o(1)` | CSetPlanetaryAscensionTier::ExecuteActual (no scan in the command or its direct callees) |
| `set_ring` | effect | `o(1)` | CSetRingEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_rule_can_subject_be_integrated` | effect | `o(1)` | CSetRuleCanSubjectBeIntegratedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_rule_can_subject_expand` | effect | `o(1)` | CSetRuleCanSubjectExpandEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_rule_join_subject_wars` | effect | `o(1)` | CSetRuleJoinSubjectWarsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_rule_subject_has_access` | effect | `o(1)` | CSetRuleSubjectHasAccessEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_rule_subject_has_sensors` | effect | `o(1)` | CSetRuleSubjectHasSensorsEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_ship_construction_type` | effect | `o(1)` | CSetShipConstructionTypeEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_site_progress_locked` | effect | `o(1)` | CSetSiteProgressLockedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_situation_locked` | effect | `o(1)` | CSetSituationLockedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_situation_progress` | effect | `o(1)` | CSetSituationProgress::ExecuteActual (no scan in the command or its direct callees) |
| `set_system_locked` | effect | `o(1)` | CSetSystemLocked::ExecuteActual (no scan in the command or its direct callees) |
| `set_trade_conversions` | effect | `o(1)` | CSetTradeConversions::ExecuteActual (no scan in the command or its direct callees) |
| `set_variable` | effect | `o(1)` | CVariables::GetVariable hash lookup; dump L1596828 |
| `set_variable_to_random_value` | effect | `o(1)` | CSetVariableToRandomValueEffect::ExecuteActual (no scan in the command or its direct callees) |
| `set_years_served` | effect | `o(1)` | CSetYearsServedEffect::ExecuteActual (no scan in the command or its direct callees) |
| `ship_size_multiplier` | trigger | `o(1)` | CShipSizeMultiplierTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `situation_monthly_progress` | trigger | `o(1)` | CSituationMonthlyProgressTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `situation_progress` | trigger | `o(1)` | CSituationProgressTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `situation_progress_percent` | trigger | `o(1)` | CSituationProgressPercentTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `specialist_tier` | trigger | `o(1)` | CSpecialistTierTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `species_gender` | trigger | `o(1)` | CSpeciesGenderTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `starbase_network_size` | trigger | `o(1)` | CStarbaseNetworkSizeTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `start_astral_action_cooldown` | effect | `o(1)` | CStartAstralActionCooldownEffect::ExecuteActual (no scan in the command or its direct callees) |
| `stop_crisis_sound` | effect | `o(1)` | CStopCrisisSoundEffect::ExecuteActual (no scan in the command or its direct callees) |
| `stop_mission` | effect | `o(1)` | CStopMissionEffect::ExecuteActual (no scan in the command or its direct callees) |
| `stop_terraform_process` | effect | `o(1)` | CStopTerraformProcessEffect::ExecuteActual (no scan in the command or its direct callees) |
| `store_country_backup_data` | effect | `o(1)` | CStoreCountryBackupDataEffect::ExecuteActual (no scan in the command or its direct callees) |
| `subject_can_diplomacy` | trigger | `o(1)` | CSubjectCanDiplomacy::ActualEvaluate (no scan in the command or its direct callees) |
| `subjects` | trigger | `o(1)` | CSubjectsTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `subtract_variable` | effect | `o(1)` | CSubtractVariableEffect::ExecuteActual (no scan in the command or its direct callees) |
| `their_opinion` | trigger | `o(1)` | CTheirOpinionTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `trust` | trigger | `o(1)` | CTrustTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `unset_cosmic_storm` | effect | `o(1)` | CUnsetCosmicStormEffect::ExecuteActual (no scan in the command or its direct callees) |
| `upgrade_days_left` | trigger | `o(1)` | CUpgradeDaysLeftTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `uplift_is_archetype` | trigger | `o(1)` | CUpliftIsArchetypeTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `used_naval_capacity_integer` | trigger | `o(1)` | CUsedNavalCapacityIntegerTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `used_naval_capacity_percent` | trigger | `o(1)` | CUsedNavalCapacityPercentTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `used_stockpile_capacity_percentage` | trigger | `o(1)` | CUsedStockpileCapacityPercentageTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `uses_ship_category` | trigger | `o(1)` | CUsesShipCategory::ActualEvaluate (no scan in the command or its direct callees) |
| `win` | effect | `o(1)` | CWinGameEffect::ExecuteActual (no scan in the command or its direct callees) |
| `won_the_game` | trigger | `o(1)` | CWonTheGameTrigger::ActualEvaluate (no scan in the command or its direct callees) |
| `years_of_peace` | trigger | `o(1)` | CYearsOfPeaceTrigger::GetTriggerValue (no scan in the command or its direct callees) |
| `years_passed` | trigger | `o(1)` | CYearsPassedTrigger::GetTriggerValue (no scan in the command or its direct callees) |

---

## 四、未标注的命令

共 418 条（Trigger 234 + Effect 184）。

这些命令在反编译结果中**无法链接到命名实现类**——dump 里注册虚表被标记为 `PTR__CTriggerEntryBase_<addr>`，不含类名。
**留白而非猜测**：给出一个未经验证的等级比不标注更糟。

---

## 五、方法论与已知局限

### 判定规则

- **仅在有正面证据时给出等级**：命令自身实现中有循环，或它直接调用的某个 helper 中有循环。
- **排除基础设施**：日志、性能计时器、字符串分配器（`CPdxLog*`、`CScopedStartProfile`、`CString`、`std::*`）自身的循环不计入。
- **排除文本处理**：`CTextBase::ProcessString` 之类遍历的是**字符串字符**而非游戏容器，不作为容器扫描证据。
- **排除 mod 自撰链**：`CFixedPointVariableValue::GetValue` 等值表达式求值器遍历脚本写的事件目标链（`owner.capital_scope.solar_system`），长度由 mod 作者决定。
- **嵌套判定保守**：仅当函数自身含嵌套循环才判 O(n²)；同一函数内两个互斥分支上的循环保持线性。
- **跳过控制流关键字**：`if` / `switch` / `while` / `random_list` 等的 "n" 是嵌套子句数量，不是引擎扫描的容器。

### 关于 n 的规模（决定实际影响）

**同为 O(n)，实际开销可能相差两个数量级**，因为 n 是各自容器的大小：

| 命令族 | n 是什么 | 典型规模 | 逐日 on_action 风险 |
| --- | --- | --- | --- |
| `has_tradition` / `has_active_tradition` | 国家已解锁的传统数 | 数十 | 低 |
| `has_*_flag` / `set_*_flag` | 该对象持有的 flag 数 | 数十～数百 | 中 |
| 航道类（`add_hyperlane` 等） | 星系超空间航道数 | 1–6 | 低 |
| `num_ships` | 舰队舰船数 | 数十～数百 | **高** |
| `has_point_of_interest` | 兴趣点集合（且为嵌套循环） | — | **高** |
| `create_military_fleet` | 嵌套循环 | — | **高** |

结论：**O(n) 不等于危险**。判断真实影响必须结合容器规模与调用频率。
真正需要警惕的是「大容器 × 高频调用」，以及上表中的 O(n²) 条目。

### 局限（务必了解）

1. **复杂度是实现形态的推断，不是基准测试**。它描述引擎代码结构，不是实测耗时。
2. **调用深度只算 1 层**。深度 2 以上若存在扫描，会被漏判为 O(1)（实测该比例约 35%）。
   因此 `o(1)` 的严格含义是「命令及其直接调用者均无循环」，而非「绝对常数时间」。
3. **O(n) 中的 n 含义各异**：可能是舰队舰船数、国家 flag 数、传统数、星系对象数等，取决于具体命令。
4. **未标注 ≠ 无开销**，只表示未能定位实现。
5. **同名命令可能同时是 trigger 与 effect**（如 `log`、`debug_break`），两处各有一行，等级可能不同。

---

## 附：验证与重新生成

```bash
# 重新生成标注数据
node tools/engine-cost/extract-engine-cost.cjs <dump.cpp> \
  --rules submodules/cwtools-stellaris-config/config \
  --out annotations.json
```
