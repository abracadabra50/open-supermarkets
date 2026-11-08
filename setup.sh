#!/bin/bash
set -e

echo "🛒 UK Grocery CLI - Interactive Setup"
echo "======================================"
echo ""

CONFIG_FILE="$HOME/.uk-grocery-config.json"

# Check if config exists
if [ -f "$CONFIG_FILE" ]; then
  echo "⚠️  Configuration file already exists: $CONFIG_FILE"
  read -p "Overwrite? (y/n): " OVERWRITE
  if [ "$OVERWRITE" != "y" ]; then
    echo "Exiting. To reconfigure, delete $CONFIG_FILE and run setup again."
    exit 0
  fi
fi

echo ""
echo "📦 Step 1: Choose Your Supermarket"
echo "-----------------------------------"
echo "Available providers:"
echo "  1) Sainsbury's (UK-wide delivery)"
echo "  2) Ocado (London & South England only)"
echo ""
read -p "Select provider (1 or 2): " PROVIDER_CHOICE

if [ "$PROVIDER_CHOICE" == "1" ]; then
  PROVIDER="sainsburys"
elif [ "$PROVIDER_CHOICE" == "2" ]; then
  PROVIDER="ocado"
else
  echo "❌ Invalid choice. Exiting."
  exit 1
fi

echo "✅ Selected: $PROVIDER"
echo ""

# Account credentials
echo "🔐 Step 2: Account Credentials"
echo "-------------------------------"
echo "Enter your $PROVIDER account details:"
read -p "Email: " EMAIL
read -sp "Password: " PASSWORD
echo ""
echo ""

# Dietary restrictions
echo "🥗 Step 3: Dietary Restrictions (optional)"
echo "------------------------------------------"
echo "Select all that apply (space-separated numbers):"
echo "  1) Vegetarian"
echo "  2) Vegan"
echo "  3) Halal"
echo "  4) Kosher"
echo "  5) Gluten-free"
echo "  6) Lactose-free"
echo "  7) None"
echo ""
read -p "Enter choices: " DIETARY_INPUT

DIETARY_RESTRICTIONS="[]"
if [[ "$DIETARY_INPUT" != *"7"* ]]; then
  RESTRICTIONS=()
  [[ "$DIETARY_INPUT" == *"1"* ]] && RESTRICTIONS+=("\"vegetarian\"")
  [[ "$DIETARY_INPUT" == *"2"* ]] && RESTRICTIONS+=("\"vegan\"")
  [[ "$DIETARY_INPUT" == *"3"* ]] && RESTRICTIONS+=("\"halal\"")
  [[ "$DIETARY_INPUT" == *"4"* ]] && RESTRICTIONS+=("\"kosher\"")
  [[ "$DIETARY_INPUT" == *"5"* ]] && RESTRICTIONS+=("\"gluten-free\"")
  [[ "$DIETARY_INPUT" == *"6"* ]] && RESTRICTIONS+=("\"lactose-free\"")
  
  if [ ${#RESTRICTIONS[@]} -gt 0 ]; then
    DIETARY_RESTRICTIONS="[$(IFS=,; echo "${RESTRICTIONS[*]}")]"
  fi
fi

echo ""

# Budget
echo "💰 Step 4: Weekly Budget (optional)"
echo "-----------------------------------"
read -p "Weekly grocery budget (£, or press Enter to skip): " WEEKLY_BUDGET

BUDGET_JSON="null"
if [ -n "$WEEKLY_BUDGET" ]; then
  BUDGET_JSON="{\"weekly\": $WEEKLY_BUDGET}"
fi

echo ""

# Household size
echo "👥 Step 5: Household Size"
echo "-------------------------"
read -p "Number of people in household: " HOUSEHOLD_SIZE

echo ""

# Organic priority
echo "🌿 Step 6: Organic Priority"
echo "---------------------------"
echo "When should organic be preferred?"
echo "  1) Always (buy organic whenever available)"
echo "  2) Dirty Dozen only (high pesticide foods only)"
echo "  3) Never (conventional always fine)"
echo "  4) Budget-based (organic if <20% more expensive)"
echo ""
read -p "Select (1-4): " ORGANIC_CHOICE

ORGANIC_PRIORITY="dirty_dozen_only"
case "$ORGANIC_CHOICE" in
  1) ORGANIC_PRIORITY="always" ;;
  2) ORGANIC_PRIORITY="dirty_dozen_only" ;;
  3) ORGANIC_PRIORITY="never" ;;
  4) ORGANIC_PRIORITY="budget_based" ;;
esac

echo ""

# External sourcing (for halal/kosher)
EXTERNAL_SOURCES="{}"
if [[ "$DIETARY_RESTRICTIONS" == *"halal"* ]] || [[ "$DIETARY_RESTRICTIONS" == *"kosher"* ]]; then
  echo "🥩 Step 7: External Sourcing"
  echo "----------------------------"
  
  if [[ "$DIETARY_RESTRICTIONS" == *"halal"* ]]; then
    echo "You selected halal. Meat will need to be purchased separately."
    read -p "Halal butcher name/location (optional): " HALAL_SOURCE
    if [ -n "$HALAL_SOURCE" ]; then
      EXTERNAL_SOURCES="{\"meat\": \"$HALAL_SOURCE\"}"
    fi
  fi
  
  echo ""
fi

# Create config JSON
echo "📝 Creating configuration..."
echo ""

# Keep credentials private from creation, then replace any old permissions/symlink.
CONFIG_TEMP=$(umask 077; mktemp "$CONFIG_FILE.XXXXXX")
trap 'rm -f -- "$CONFIG_TEMP"' EXIT
trap 'exit 1' HUP INT TERM

cat > "$CONFIG_TEMP" << EOF
{
  "provider": "$PROVIDER",
  "email": "$EMAIL",
  "password": "$PASSWORD",
  "dietary_restrictions": $DIETARY_RESTRICTIONS,
  "budget": $BUDGET_JSON,
  "household_size": $HOUSEHOLD_SIZE,
  "organic_priority": "$ORGANIC_PRIORITY",
  "external_sources": $EXTERNAL_SOURCES,
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

mv -f -- "$CONFIG_TEMP" "$CONFIG_FILE"
trap - EXIT HUP INT TERM

echo "✅ Configuration saved to $CONFIG_FILE"
echo ""

# Attempt login
echo "🔐 Testing login..."
echo ""

# Use the CLI's environment input so the password never appears in process arguments.
if SUPERMARKET_PASSWORD="$PASSWORD" npx ts-node src/cli.ts --provider "$PROVIDER" login --email "$EMAIL" 2>&1 | grep -q "Logged in"; then
  echo "✅ Login successful!"
  echo ""
else
  echo "⚠️  Login failed. You may need to login manually:"
  echo "   groc --provider $PROVIDER login --email $EMAIL --password YOUR_PASSWORD"
  echo ""
fi

# Show next steps
echo "🎉 Setup Complete!"
echo "=================="
echo ""
echo "Your configuration:"
echo "  Provider: $PROVIDER"
echo "  Email: $EMAIL"
echo "  Dietary: $DIETARY_RESTRICTIONS"
echo "  Budget: $([ "$BUDGET_JSON" == "null" ] && echo "None" || echo "£$WEEKLY_BUDGET/week")"
echo "  Household: $HOUSEHOLD_SIZE people"
echo "  Organic: $ORGANIC_PRIORITY"
echo ""
echo "Next steps:"
echo "  1. Search products:    groc search \"milk\""
echo "  2. Add to basket:      groc add <product-id> --qty 2"
echo "  3. View basket:        groc basket"
echo "  4. Checkout:           groc checkout"
echo ""
echo "Configuration file: $CONFIG_FILE"
echo "To reconfigure: rm $CONFIG_FILE && npm run setup"
echo ""
