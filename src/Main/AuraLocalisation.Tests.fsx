#r "../../artifacts/bin/Main/debug/FParsec.dll"
#r "../../artifacts/bin/Main/debug/FParsecCS.dll"
#r "../../artifacts/bin/Main/debug/CWTools.dll"

#load "../TestHelpers.fsx"
#load "AuraLocalisation.fs"

open CWTools.Utilities.Position
open Main.AuraLocalisation
open TestHelpers

let harness = TestHarness("AuraLocalisation")

let equal name expected actual = harness.Equal name expected actual
let check name condition = harness.Check name condition

let samplePath = "common/component_templates/auras.txt"

let fileResult text = collect samplePath text scopeFile None

let blockResult text =
    parseText samplePath text
    |> Option.bind (fun root -> findAuras root |> List.tryHead)
    |> Option.map (fun (node, _) -> collect samplePath text scopeBlock (Some node.Position.Start))

let friendlySample =
    """
utility_component_template = {
	key = "SRA_AURA_5_1"
	friendly_aura = {
		name = "SRA_Aura_5_1"
		radius = 2000
		system_wide = yes
		apply_on = ships

		stack_info = {
			id = SRA_Aura_5_1
			priority = 200
		}

		modifier = {
			ship_shield_damage_mult = 0.5
			ship_armor_damage_mult = 0.5
			ship_hull_damage_mult = 0.5
		}
	}
}
"""

let expectedFriendlyText =
    "§Y防御性光环§!\\n对盟友舰船效果：\\n $MOD_SHIP_SHIELD_DAMAGE_MULT$：§G+50%§!\\n $MOD_SHIP_ARMOR_DAMAGE_MULT$：§G+50%§!\\n $MOD_SHIP_HULL_DAMAGE_MULT$：§G+50%§!"

let expectedFriendlyLine = "SRA_Aura_5_1:0 \"" + expectedFriendlyText + "\""

let friendlyResult = fileResult friendlySample

equal "friendly aura renders the documented tooltip line" [ expectedFriendlyLine ] friendlyResult.Lines
equal "friendly aura reports one entry" 1 friendlyResult.Entries.Length
equal "friendly aura entry text" expectedFriendlyText friendlyResult.Entries.Head.Text
equal "friendly aura entry key" "SRA_Aura_5_1" friendlyResult.Entries.Head.Key
equal "friendly aura entry kind" "friendly" (kindName friendlyResult.Entries.Head.Kind)
equal "friendly aura entry start line" 4 friendlyResult.Entries.Head.StartLine

match blockResult friendlySample with
| Some result -> equal "cursor inside the aura generates the same line" [ expectedFriendlyLine ] result.Lines
| None -> harness.Fail("cursor inside the aura generates the same line", "block scope returned no result")

let hostileSample =
    """
utility_component_template = {
	key = "SRA_AURA_HOSTILE"
	hostile_aura = {
		name = "SRA_Aura_Hostile"
		apply_on = fleets
		stack_info = { id = SRA_Hostile_1 }
		modifier = {
			custom_tooltip = SRA_Aura_Hostile_tooltip
			show_only_custom_tooltip = yes
			ship_tracking_add = 10
			ship_fire_rate_mult = 0.25
			ship_damage = -5
			leader_age = 0.5
		}
		damage_per_day = {
			accuracy = 0.75
			damage = { min = 1 max = 2 }
			shield_damage = 0.5
			hull_damage = 2
			armor_penetration = 1
		}
	}
}
"""

let expectedHostileText =
    "§Y敌对光环§!\\n对敌方舰队效果：\\n $MOD_SHIP_TRACKING_ADD$：§G+10§!\\n $MOD_SHIP_FIRE_RATE_MULT$：§G+25%§!\\n $MOD_SHIP_DAMAGE$：§R-5§!\\n $MOD_LEADER_AGE$：§G+50%§!\\n 每日伤害：§G1-2§!\\n 护盾伤害：§G50%§!\\n 船体伤害：§G2§!\\n 命中率：§G75%§!\\n 装甲穿透：§G1§!"

let hostileText = (fileResult hostileSample).Entries.Head.Text

equal "hostile aura renders modifiers then damage_per_day" expectedHostileText hostileText
check "custom_tooltip is not treated as a modifier" (not (hostileText.Contains "$MOD_CUSTOM_TOOLTIP$"))
check "show_only_custom_tooltip is not treated as a modifier" (not (hostileText.Contains "$MOD_SHOW_ONLY_CUSTOM_TOOLTIP$"))

let percentSample =
    """
utility_component_template = {
	key = "SRA_AURA_PERCENT"
	friendly_aura = {
		name = SRA_Aura_Percent
		apply_on = ships
		modifier = {
			ship_fire_rate_mult = 2
			ship_weapon_damage = -0.5
			ship_evasion_add = 0.1
			ship_evasion = 5
			ship_speed = 0
		}
	}
}
"""

let expectedPercentText =
    "§Y防御性光环§!\\n对盟友舰船效果：\\n $MOD_SHIP_FIRE_RATE_MULT$：§G+200%§!\\n $MOD_SHIP_WEAPON_DAMAGE$：§R-50%§!\\n $MOD_SHIP_EVASION_ADD$：§G+10%§!\\n $MOD_SHIP_EVASION$：§G+5§!\\n $MOD_SHIP_SPEED$：§G+0§!"

equal "multipliers and fractional literals render as percentages" expectedPercentText (fileResult percentSample).Entries.Head.Text

let singleValueDamageSample =
    """
utility_component_template = {
	key = "SRA_AURA_DAMAGE"
	hostile_aura = {
		name = SRA_Aura_Damage
		apply_on = ships
		damage_per_day = { damage = { min = 3 max = 3 } hull_damage = 1.5 }
	}
}
"""

let expectedSingleValueDamageText =
    "§Y敌对光环§!\\n对敌方舰船效果：\\n 每日伤害：§G3§!\\n 船体伤害：§G150%§!"

equal "equal damage bounds collapse to a single value" expectedSingleValueDamageText (fileResult singleValueDamageSample).Entries.Head.Text

let nameFallbackSample =
    """
utility_component_template = {
	key = "SRA_AURA_NAME_ONLY"
	friendly_aura = {
		name = "SRA_Aura_Name_Only"
		apply_on = ships
		modifier = { ship_tracking_add = 1 }
	}
}
"""

equal "stack_info.id falls back to name" "SRA_Aura_Name_Only" (fileResult nameFallbackSample).Entries.Head.Key

let noKeySample =
    """
utility_component_template = {
	key = "SRA_AURA_NO_KEY"
	friendly_aura = {
		apply_on = ships
		modifier = { ship_tracking_add = 1 }
	}
}
"""

let noKeyResult = fileResult noKeySample

equal "an aura without stack_info.id and name produces no line" [] noKeyResult.Lines
check "an aura without stack_info.id and name is reported" (not noKeyResult.Messages.IsEmpty)
equal "an aura without stack_info.id and name is not ok" false noKeyResult.Ok

let duplicateSample =
    """
utility_component_template = {
	key = "SRA_AURA_DUP_A"
	friendly_aura = {
		stack_info = { id = SRA_Dup }
		modifier = { ship_tracking_add = 1 }
	}
}
utility_component_template = {
	key = "SRA_AURA_DUP_B"
	hostile_aura = {
		stack_info = { id = SRA_Dup }
		modifier = { ship_tracking_add = 2 }
	}
}
"""

let duplicateResult = fileResult duplicateSample

equal "duplicate localisation keys keep one line" 1 duplicateResult.Lines.Length
equal "duplicate localisation keys are reported" 1 duplicateResult.Messages.Length
check "duplicate localisation keys keep the first aura" (duplicateResult.Lines.Head.Contains "$MOD_SHIP_TRACKING_ADD$：§G+1§!")

let twoAuraSample =
    """
utility_component_template = {
	key = "SRA_AURA_TWO_A"
	friendly_aura = {
		stack_info = { id = SRA_Two_A }
		modifier = { ship_tracking_add = 1 }
	}
}
utility_component_template = {
	key = "SRA_AURA_TWO_B"
	hostile_aura = {
		stack_info = { id = SRA_Two_B }
		modifier = { ship_tracking_add = 2 }
	}
}
"""

let twoAuraResult = fileResult twoAuraSample

equal "file scope keeps both keys" [ "SRA_Two_A"; "SRA_Two_B" ] (twoAuraResult.Entries |> List.map (fun entry -> entry.Key))
equal "file scope keeps source order" "friendly" (kindName twoAuraResult.Entries.Head.Kind)

match parseText samplePath twoAuraSample with
| Some root ->
    let outsideCursor = collect samplePath twoAuraSample scopeBlock (Some(mkPos 1 0))
    equal "a cursor outside every aura block reports a message" [ "光标不在 friendly_aura / hostile_aura 块内" ] outsideCursor.Messages
    equal "a cursor outside every aura block is not ok" false outsideCursor.Ok
    equal "no aura block is found at line 1" None (findAuraAt root (mkPos 1 0) |> Option.map snd)
| None -> harness.Fail("a cursor outside every aura block reports a message", "the sample did not parse")

let brokenSample = "utility_component_template = { key = \"SRA_BROKEN\""

equal "an unparsable buffer is reported" false (fileResult brokenSample).Ok
equal "an unparsable buffer produces no lines" [] (fileResult brokenSample).Lines
equal "block scope without a position is reported" [ "缺少光标位置参数" ] (collect samplePath friendlySample scopeBlock None).Messages
equal "an unknown scope falls back to block scope" "block" (collect samplePath friendlySample "nonsense" None).Scope
equal "file scope is kept" "file" (collect samplePath friendlySample scopeFile None).Scope

check "component template paths are detected (windows)" (isComponentTemplatePath "C:\\mod\\common\\component_templates\\auras.txt")
check "component template paths are detected (posix)" (isComponentTemplatePath "mod/common/component_templates/auras.txt")
check "other paths are rejected" (not (isComponentTemplatePath "mod/common/technology/techs.txt"))
check "non-txt component template siblings are rejected" (not (isComponentTemplatePath "mod/common/component_templates/auras.gfx"))
check "aura keys are detected case-insensitively" (containsAuraKey "FRIENDLY_AURA = {")
check "unrelated script text is rejected" (not (containsAuraKey "modifier = { ship_tracking_add = 1 }"))
check "aura presence at a position is detected" (hasAuraAt samplePath friendlySample (mkPos 4 3))
check "aura presence outside a block is rejected" (not (hasAuraAt samplePath friendlySample (mkPos 1 0)))

harness.Summary() |> ignore
