// Firebase imports (CDN ESM modules)
// Note: Browsers can't resolve bare imports like "firebase/app" without a bundler.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, collection, query, orderBy, limit, onSnapshot, doc, setDoc, deleteDoc, getDocs } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAtqaz8FSpuOvvw5fTNisHXlJQ0cdVebfk",
  authDomain: "farming-game-dc69d.firebaseapp.com",
  projectId: "farming-game-dc69d",
  storageBucket: "farming-game-dc69d.firebasestorage.app",
  messagingSenderId: "66379455382",
  appId: "1:66379455382:web:8aacd4af449190a32f1bb7",
  measurementId: "G-KKMBMM437Z"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Wait for auth before doing any Firestore reads.
let resolveAuthReady;
const authReady = new Promise((resolve) => {
    resolveAuthReady = resolve;
});
onAuthStateChanged(auth, (user) => {
    if (user) resolveAuthReady(user);
});

// Authenticate anonymously
signInAnonymously(auth)
  .then(() => {
    console.log('Signed in anonymously');
  })
  .catch((error) => {
    console.error('Anonymous sign-in failed:', error);
  });

let leaderboardSaveTimer = null;
function scheduleLeaderboardSave(totalWorth) {
        if (leaderboardSaveTimer) clearTimeout(leaderboardSaveTimer);
        leaderboardSaveTimer = setTimeout(() => {
                sendDataToServer(totalWorth);
        }, 500);
}

function calculateNet() {
    //console.log('Calculating net values...');
    const rows = document.querySelectorAll('#spreadsheet tr');

    rows.forEach((row, index) => {
        if (index === 0) return;
        if (row.classList.contains('highlight')) return;

        const netValueCell = row.querySelector('.net');
        if (!netValueCell) return;

        // Columns: 0 Assets, 1 Acres, 2 Qty, 3 Cost, 4 Net
        const acresCell = row.cells[1];
        const qtyCell = row.cells[2];
        const costCell = row.cells[3];
        const netCell = row.cells[4];

        if (!qtyCell || !costCell || !netCell) return;

        const qtyValueEl = qtyCell.querySelector('span.editable');
        const qtyRaw = (qtyValueEl ? qtyValueEl.textContent : qtyCell.innerText).replace(/,/g, '').trim();
        const qty = parseFloat(qtyRaw) || 0;
        const cost = parseFloat((costCell.innerText || '').replace(/,/g, '').trim()) || 0;
        const net = qty * cost;

        netCell.textContent = numberWithCommasAndDecimals(net);

        const acresPerUnit = parseFloat(row.getAttribute('data-acres-per-unit') || '0') || 0;
        if (acresCell) {
            if (acresPerUnit > 0) {
                acresCell.textContent = numberWithCommasAndDecimals(qty * acresPerUnit);
            } else {
                acresCell.textContent = '';
            }
        }
    });

    updateTotalAcres(); // Update total acres
    updateTotalWorth(true); // Update the total worth after net values are calculated (debounced save)
}

function handleTransaction(inputId, transactionClass, totalClass) {
    const inputElement = document.getElementById(inputId);
    if (inputElement && inputElement.value.trim() !== '') {
        const newValue = parseFloat(inputElement.value.trim().replace(/,/g, '')) || 0;
        
        // Check loan limit for loan transactions
        if (transactionClass.includes('loan') && newValue > 0) {
            updateTotals();
            const currentLoanTotal = getCurrentLoanTotal();
            if (currentLoanTotal + newValue > 50000) {
                alert('Loan transaction would exceed the $50,000 debt limit. Current debt: $' + currentLoanTotal.toLocaleString() + ', Additional loan: $' + newValue.toLocaleString() + '.');
                inputElement.value = '';
                return;
            }
        }

        const table = document.getElementById('financialTable');
        // Check for an existing empty transaction cell
        let emptyCellFound = false;
        const transactionCells = document.querySelectorAll(`.${transactionClass}`);
        for (let cell of transactionCells) {
            if (cell.textContent.trim() === '') {
                // cell.textContent = inputElement.value; // Use the empty cell for the new transaction
                cell.contentEditable = 'true'; // Make it editable
                emptyCellFound = true;
                break;
            }
        }

        // // If no empty cell was found, create a new row
        if (!emptyCellFound) {
            const newRow = table.insertRow(); // Insert below the input cells
            if (inputId === 'cashInput') {
                createTransactionCell(newRow, 'cash-transaction', '', true); // Empty, editable cell for alignment
                createTransactionCell(newRow, 'cash-total');
                createTransactionCell(newRow, 'loan-transaction', '', true); // Empty, editable cell for alignment
                createTransactionCell(newRow, 'loan-total', '', true); // Empty, editable cell for alignment
            } else {
                createTransactionCell(newRow, 'cash-transaction', '', true); // Empty, editable cell for alignment
                createTransactionCell(newRow, 'cash-total', '', true); // Empty, editable cell for alignment
                createTransactionCell(newRow, 'loan-transaction', '', true); // Empty, editable cell for alignment
                createTransactionCell(newRow, 'loan-total');
            }
        }

        shiftAndInsertTransaction(inputId,transactionClass);
        // Calculate the new total
        updateTotals();
        saveQuantitiesToLocalStorage();
        
        // Remove excess rows beyond 10 transactions
        // Row 0 = headers, Row 1 = instructions, Row 2 = transaction headers, Row 3+ = transactions
        const maxRows = 13; // 3 header rows + 10 transaction rows
        while (table.rows.length > maxRows) {
            table.deleteRow(table.rows.length - 1);
        }
        
        // Clear the input field after the transaction is added
        inputElement.value = '';
    }
}

function addCashTransactionValue(amount) {
    if (!data.transactions) data.transactions = { cash: [], loan: [] };
    if (!Array.isArray(data.transactions.cash)) data.transactions.cash = [];
    if (!Array.isArray(data.transactions.loan)) data.transactions.loan = [];

    const numericValue = parseFloat(String(amount).replace(/,/g, ''));
    if (!Number.isFinite(numericValue)) return;

    data.transactions.cash.unshift(String(numericValue));
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    saveQuantitiesToLocalStorage();
}

function addLoanTransactionValue(amount) {
    if (!data.transactions) data.transactions = { cash: [], loan: [] };
    if (!Array.isArray(data.transactions.cash)) data.transactions.cash = [];
    if (!Array.isArray(data.transactions.loan)) data.transactions.loan = [];

    const numericValue = parseFloat(String(amount).replace(/,/g, ''));
    if (!Number.isFinite(numericValue)) return;

    // Check loan limit for positive loan amounts
    if (numericValue > 0) {
        updateTotals();
        const currentLoanTotal = getCurrentLoanTotal();
        if (currentLoanTotal + numericValue > 50000) {
            console.warn('Loan transaction would exceed the $50,000 debt limit. Current debt: $' + currentLoanTotal.toLocaleString() + ', Additional loan: $' + numericValue.toLocaleString() + '.');
            return; // Silently fail for programmatic calls
        }
    }

    data.transactions.loan.unshift(String(numericValue));
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    saveQuantitiesToLocalStorage();
}

function undoLastCashTransaction() {
    if (!data.transactions || !Array.isArray(data.transactions.cash) || data.transactions.cash.length === 0) {
        console.log('No cash transactions to undo');
        return;
    }

    const removed = data.transactions.cash.shift();
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    saveQuantitiesToLocalStorage();
    console.log(`Undid cash transaction ${removed}`);
}

function undoLastLoanTransaction() {
    if (!data.transactions || !Array.isArray(data.transactions.loan) || data.transactions.loan.length === 0) {
        console.log('No loan transactions to undo');
        return;
    }

    const removed = data.transactions.loan.shift();
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    saveQuantitiesToLocalStorage();
    console.log(`Undid loan transaction ${removed}`);
}

function shiftAndInsertTransaction(inputId, transactionClass) {
    // Get the value from the input
    const inputElement = document.getElementById(inputId);
    const newValue = inputElement.value.trim();

    // Check that the value is not empty
    if (newValue !== '') {
        // Determine which transaction type (cash or loan)
        const transactionType = transactionClass.includes('cash') ? 'cash' : 'loan';
        
        // Add new transaction to the beginning of the global data array
        data.transactions[transactionType].unshift(newValue);
        
        // Select all the transaction cells for cash or loan
        const transactionCells = document.querySelectorAll(`.${transactionClass}`);
        
        // Update only the visible cells (first 10 from data)
        const visibleTransactions = data.transactions[transactionType].slice(0, 10);
        visibleTransactions.forEach((value, index) => {
            if (transactionCells[index]) {
                transactionCells[index].textContent = numberWithCommasAndDecimals(value);
            }
        });

        // Clear the input element
        inputElement.value = '';

        // After shifting values, recalculate the total
        updateTotals();

    }
}

function syncDOMToData() {
    // Sync visible transaction cells back to the data object
    const cashCells = document.querySelectorAll('.cash-transaction');
    const loanCells = document.querySelectorAll('.loan-transaction');
    
    // Ensure data.transactions exists
    if (!data.transactions) {
        data.transactions = { cash: [], loan: [] };
    }
    
    // Rebuild cash transactions from DOM cells, filtering out empty ones
    data.transactions.cash = [];
    cashCells.forEach((cell) => {
        const cellValue = cell.textContent.trim();
        if (cellValue !== '') {
            // Parse the formatted value back to a raw number string
            const numericValue = parseFloat(cellValue.replace(/,/g, ''));
            if (!isNaN(numericValue)) {
                data.transactions.cash.push(String(numericValue));
            }
        }
    });
    
    // Rebuild loan transactions from DOM cells, filtering out empty ones
    data.transactions.loan = [];
    loanCells.forEach((cell) => {
        const cellValue = cell.textContent.trim();
        if (cellValue !== '') {
            // Parse the formatted value back to a raw number string
            const numericValue = parseFloat(cellValue.replace(/,/g, ''));
            if (!isNaN(numericValue)) {
                data.transactions.loan.push(String(numericValue));
            }
        }
    });
    
    // Save to localStorage after syncing
    saveQuantitiesToLocalStorage();
}

function makeCellEditable(cell) {
    cell.contentEditable = 'true';
    
    // Event listener for input events to update the total immediately after a change
    cell.addEventListener('input', () => {
        syncDOMToData(); // Sync changes back to global data
        updateTotals();
    });

    // Event listener for keydown events to handle the Enter key
    cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent the default Enter key action
            cell.blur(); // Remove focus from the cell
            syncDOMToData(); // Ensure data is synced on Enter
            updateTotals(); // Recalculate the total when Enter is pressed
            
        }
    });
}


// Call this function after creating a new transaction cell
function createTransactionCell(row, className, value = '', isEditable = false) {
    const cell = row.insertCell();
    cell.className = className;
    cell.textContent = value;
    if (isEditable) {
        makeCellEditable(cell);
    }
}

function getCurrentCashTotal() {
    if (data && data.transactions && Array.isArray(data.transactions.cash)) {
        return data.transactions.cash.reduce((sum, val) => sum + (parseFloat(String(val).replace(/,/g, '')) || 0), 0);
    }
    const cashTotalCell = document.querySelector('.cash-total');
    return cashTotalCell ? (parseFloat(String(cashTotalCell.textContent).replace(/,/g, '')) || 0) : 0;
}

function getCurrentLoanTotal() {
    if (data && data.transactions && Array.isArray(data.transactions.loan)) {
        return data.transactions.loan.reduce((sum, val) => sum + (parseFloat(String(val).replace(/,/g, '')) || 0), 0);
    }
    const loanTotalCell = document.querySelector('.loan-total');
    return loanTotalCell ? (parseFloat(String(loanTotalCell.textContent).replace(/,/g, '')) || 0) : 0;
}

function getCurrentInterestValue() {
    const interestCell = document.querySelector('.interest');
    return interestCell ? (parseFloat(String(interestCell.textContent).replace(/,/g, '')) || 0) : 0;
}

function setButtonDisabled(button, disabled) {
    if (!button) return;
    button.disabled = !!disabled;
    button.classList.toggle('is-disabled', !!disabled);
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

function updateActionButtonStates() {
    const cashTotal = getCurrentCashTotal();

    // Pay Interest
    const payInterestBtn = document.getElementById('payInterestBtn');
    if (payInterestBtn) {
        const interest = getCurrentInterestValue();
        const disabled = !(interest > 0) || cashTotal < interest;
        setButtonDisabled(payInterestBtn, disabled);
    }

    // Buy buttons (minimum 20% down)
    document.querySelectorAll('button.buy-btn[data-asset]').forEach((btn) => {
        const row = btn.closest('tr');
        const costCell = row && row.cells ? row.cells[3] : null;
        const cost = costCell ? (parseFloat(String(costCell.textContent).replace(/,/g, '')) || 0) : 0;
        const requiredDown = Math.round(cost * 0.2);
        const disabled = requiredDown > 0 && cashTotal < requiredDown;
        setButtonDisabled(btn, disabled);
    });
}

function updateTotals() {
    // Calculate totals from global data object, not localStorage
    // This ensures all entries contribute to the total, including newly added ones
    let cashTotal = 0;
    let loanTotal = 0;

    if (data && data.transactions) {
        // Sum all cash transactions from global data object
        cashTotal = data.transactions.cash.reduce((sum, val) => {
            return sum + (parseFloat(val.replace(/,/g, '')) || 0);
        }, 0);
        // Sum all loan transactions from global data object
        loanTotal = data.transactions.loan.reduce((sum, val) => {
            return sum + (parseFloat(val.replace(/,/g, '')) || 0);
        }, 0);
    }

    // Update the total cells
    const cashTotalCell = document.querySelector('.cash-total');
    if (cashTotalCell) {
        cashTotalCell.textContent = numberWithCommasAndDecimals(cashTotal);
    }

    const loanTotalCell = document.querySelector('.loan-total');
    if (loanTotalCell) {
        loanTotalCell.textContent = numberWithCommasAndDecimals(loanTotal);
    }

    // Update net cash, total worth, and interest after updating totals
    updateNetCash();
    updateTotalWorth(true);
    updateInterest();

    // Keep UI buttons in sync with affordability
    updateActionButtonStates();
}

function updateTotalAcres() {
    const rows = document.querySelectorAll('#spreadsheet tr');
    let totalAcres = 0;

    rows.forEach((row, index) => {
        if (index === 0) return;
        if (row.classList.contains('highlight')) return;

        const netCell = row.querySelector('.net');
        if (!netCell) return;

        const acresPerUnit = parseFloat(row.getAttribute('data-acres-per-unit') || '0') || 0;
        if (!(acresPerUnit > 0)) return;

        const qtyCell = row.cells[2];
        if (!qtyCell) return;
        const qtyValueEl = qtyCell.querySelector('span.editable');
        const qtyRaw = (qtyValueEl ? qtyValueEl.textContent : qtyCell.innerText).replace(/,/g, '').trim();
        const qty = parseFloat(qtyRaw) || 0;

        totalAcres += qty * acresPerUnit;
    });

    const totalAcresCell = document.querySelector('.total-acres');
    if (totalAcresCell) {
        totalAcresCell.textContent = numberWithCommasAndDecimals(totalAcres);
    }
}


function updateNetCash() {
    // Retrieve and parse the total cash and total loan values
    const cashTotalValue = parseFloat(document.querySelector('.cash-total').textContent.replace(/,/g, '') || 0);
    const loanTotalValue = parseFloat(document.querySelector('.loan-total').textContent.replace(/,/g, '') || 0);
    
    // Calculate net cash
    const netCash = cashTotalValue - loanTotalValue;

    // Update the net cash cell with formatted value
    const netCashCell = document.querySelector('.net-cash');
    if (netCashCell) {
        netCashCell.textContent = numberWithCommasAndDecimals(netCash);
    }
}


function updateInterest() {
    // Retrieve and parse the loan total value
    const loanTotalText = document.querySelector('.loan-total').textContent.replace(/,/g, '');
    // Convert to float and handle potential NaN if the text can't be converted
    const loanTotalValue = parseFloat(loanTotalText) || 0;
    
    // Calculate interest (assuming interest is 10% of loan total)
    // The interest is also rounded to the nearest cent using Math.round
    const interestValue = Math.round((loanTotalValue) * 10) / 100;

    // Update the interest cell with formatted value
    const interestCell = document.querySelector('.interest');
    if (interestCell) {
        interestCell.textContent = numberWithCommasAndDecimals(interestValue);
    }
}

function updateTotalWorth(sendData) {
    // Select all the net value cells
    const netValueCells = document.querySelectorAll('.net');
    let totalWorth = 0;

    // Sum all net value cell amounts
    netValueCells.forEach(cell => {
        totalWorth += parseFloat(cell.textContent.replace(/,/g, '')) || 0; // Remove any commas and parse to float
    });

    // Get the net cash value
    const netCashCell = document.querySelector('.net-cash');
    const netCashValue = netCashCell ? parseFloat(netCashCell.textContent.replace(/,/g, '')) || 0 : 0;

    // Add the net cash value to the total worth
    totalWorth += netCashValue;

    // Update the total worth cell
    const totalWorthCell = document.querySelector('.total-worth');
    // if (totalWorthCell) totalWorthCell.textContent = totalWorth.toFixed(2); // Format to 2 decimal places
    if (totalWorthCell) totalWorthCell.textContent = numberWithCommasAndDecimals(totalWorth);
    // Send the username and total worth to the server
    if (sendData) scheduleLeaderboardSave(totalWorth);
}

function sendDataToServer(totalWorth) {
    
    const usernameCell = document.getElementById('editableUsername');
    const username = usernameCell.innerText.trim();
    
    // console.log('Sending data to server:', { username: username, networth: totalWorth });
    // Check if username is valid
    if (username === '' || username === 'Enter name') {
        console.log('Invalid username, not sending data');
        return;
    }

    // Ensure user is authenticated
    if (!auth.currentUser) {
        console.log('User not authenticated, skipping save');
        return;
    }

    const hayQty = parseInt(document.querySelector('.qty-hay')?.textContent || '0', 10) || 0;
    const grainQty = parseInt(document.querySelector('.qty-grain')?.textContent || '0', 10) || 0;
    const fruitQty = parseInt(document.querySelector('.qty-fruit')?.textContent || '0', 10) || 0;
    const farmCowsQty = parseInt(document.querySelector('.qty-farm')?.textContent || '0', 10) || 0;
    const ranchCowsQty = parseInt(document.querySelector('.qty-cows')?.textContent || '0', 10) || 0;
    const cowsQty = farmCowsQty + ranchCowsQty;

    const loanTotalCell = document.querySelector('.loan-total');
    const debt = loanTotalCell ? (parseFloat(loanTotalCell.textContent.replace(/,/g, '')) || 0) : 0;

    // Save to Firestore
    const userDocRef = doc(db, 'leaderboard', username);
    setDoc(userDocRef, {
        username: username,
        networth: totalWorth,
        debt: debt,
        hay: hayQty,
        grain: grainQty,
        fruit: fruitQty,
        cows: cowsQty,
        updatedAt: new Date()
    })
    .then(() => {
        console.log('Data saved to Firestore');
    })
    .catch((error) => {
        console.error('Error saving to Firestore:', error);
    });
      
}

  
// Function to update the leaderboard table with fetched data
function updateLeaderboardTable(data) {
    const leaderboardTable = document.getElementById('leaderboard');
    const tbody = leaderboardTable.querySelector('tbody');

    // Clear existing rows in the table body
    tbody.innerHTML = '';

    // Create a new row for each entry in the fetched data
    data.forEach(entry => {
        const row = document.createElement('tr');

        const usernameCell = document.createElement('td');
        usernameCell.textContent = entry.username;
        usernameCell.className = 'text-center';

        const networthCell = document.createElement('td');
        networthCell.textContent = parseFloat(entry.networth).toLocaleString('en-US'); // Format the number with commas
        networthCell.className = 'text-center';

        const debtCell = document.createElement('td');
        debtCell.textContent = parseFloat(entry.debt ?? 0).toLocaleString('en-US');
        debtCell.className = 'text-center';

        const hayCell = document.createElement('td');
        hayCell.textContent = (entry.hay ?? 0).toString();
        hayCell.className = 'text-center';

        const grainCell = document.createElement('td');
        grainCell.textContent = (entry.grain ?? 0).toString();
        grainCell.className = 'text-center';

        const fruitCell = document.createElement('td');
        fruitCell.textContent = (entry.fruit ?? 0).toString();
        fruitCell.className = 'text-center';

        const cowsCell = document.createElement('td');
        cowsCell.textContent = (entry.cows ?? 0).toString();
        cowsCell.className = 'text-center';

        // Append cells to the row
        row.appendChild(usernameCell);
        row.appendChild(networthCell);
        row.appendChild(debtCell);
        row.appendChild(hayCell);
        row.appendChild(grainCell);
        row.appendChild(fruitCell);
        row.appendChild(cowsCell);

        // Append the row to the table body
        tbody.appendChild(row);
    });
}

// Function to start Firestore real-time listener
function startFirestoreListener() {
    // Listen for real-time updates to the leaderboard
    const q = query(collection(db, 'leaderboard'), orderBy('networth', 'desc'), limit(10));
    
    onSnapshot(q, (querySnapshot) => {
        const leaderboardData = [];
        querySnapshot.forEach((doc) => {
            leaderboardData.push(doc.data());
        });
        
        // Update your leaderboard UI
        updateLeaderboardTable(leaderboardData);
    }, (error) => {
        console.error('Firestore listener error:', error);
    });
}

// Start the Firestore listener when auth is ready
authReady
    .then(() => startFirestoreListener())
    .catch((err) => console.error('Auth wait failed:', err));


function getCurrentTotalWorthFromDOM() {
    const totalWorthCell = document.querySelector('.total-worth');
    if (!totalWorthCell) return null;
    return parseFloat(totalWorthCell.textContent.replace(/,/g, '')) || 0;
}

function commitUsernameEdit() {
    const usernameCell = document.getElementById('editableUsername');
    if (!usernameCell) return;

    const trimmed = usernameCell.innerText.trim();
    if (trimmed === '') {
        usernameCell.innerText = 'Enter name';
        saveQuantitiesToLocalStorage();
        return;
    }

    saveQuantitiesToLocalStorage();

    const totalWorth = getCurrentTotalWorthFromDOM();
    if (totalWorth !== null) scheduleLeaderboardSave(totalWorth);
}


function makeEditableCellsExitOnEnter() {
    const editableElements = document.querySelectorAll('td.editable, span.editable');

    editableElements.forEach((el) => {
        if (el.dataset && el.dataset.exitOnEnterBound === '1') return;
        if (el.dataset) el.dataset.exitOnEnterBound = '1';

        const commit = () => {
            // Qty / other editable cells
            calculateNet();
            populateRollTable();
            saveQuantitiesToLocalStorage();
        };

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                el.blur();
                commit();
            }
        });

        // "Tap outside" / click away
        el.addEventListener('blur', commit);
    });
}

// This function should be called during initial setup and whenever new editable cells are added
makeEditableCellsExitOnEnter();
//console.log('log working')
function numberWithCommasAndDecimals(x) {
    //console.log('numberWithCommasAndDecimals called with:', x);

    // Parse the input as a float and ensure two decimal places
    const numericValue = parseFloat(x);
    if (isNaN(numericValue)) {
        //console.error('Input is not a valid number:', x);
        return '0.00';
    }

    // Convert the number to a string with two decimal places
    let parts = numericValue.toFixed(2).split(".");
    //console.log('Split parts:', parts);

    // Add commas to the integer part
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    //console.log('Integer part with commas:', parts[0]);

    // If the decimal part is only one digit, append a zero
    if (parts[1].length < 2) {
        parts[1] = parts[1] + '0';
    }
    //console.log('Decimal part after check:', parts[1]);

    // Combine the integer part with the decimal part
    const formattedNumber = parts[0] + "." + parts[1];
    //console.log('Formatted number:', formattedNumber);

    return formattedNumber;
}

// Example usage:
//console.log(numberWithCommasAndDecimals('1107.1')); // Should log '1,105.10'

function populateRollTable() {
    // Define the base monetary values for each roll and item type
    const baseValues = {
      Hay: [400, 600, 1000, 1500, 2200, 3000],
      Grain: [800, 1500, 2500, 3800, 5300, 7000],
      Fruit: [2000, 3500, 6000, 9000, 13000, 17500],
      Cows: [1400, 2000, 2800, 3800, 5000, 7500]
    };
    
    // Get the quantities from the contenteditable cells
    // Assuming these cells have an id or a specific class to identify them
    const quantities = {
      Hay: parseInt(document.querySelector('.qty-hay').textContent) || 0,
      Grain: parseInt(document.querySelector('.qty-grain').textContent) || 0,
      Fruit: parseInt(document.querySelector('.qty-fruit').textContent) || 0,
      Cows: (parseInt(document.querySelector('.qty-farm').textContent) || 0) +
        (parseInt(document.querySelector('.qty-cows').textContent) || 0)
    };
  
    // Get all rows in the roll table except the header row
    const rollRows = document.querySelectorAll('.roll-table tr:not(:first-child)');
  
    rollRows.forEach((row, index) => {
      const assetType = row.cells[0].textContent.split(' ')[0]; // Get the asset type (Hay, Grain, etc.) without suffix
      const quantity = quantities[assetType] || 0; // Get the quantity for this asset type

            let multiplier = 1;
            if (assetType === 'Hay') {
                if (quantity >= 10) multiplier = 2;
                else if (quantity >= 5) multiplier = 1.5;
            }

            // Manual multiplier from tapping
            const state = parseInt(row.cells[0].getAttribute('data-state') || 0);
            let manualMultiplier = 1;
            if (state === 1) manualMultiplier = 0.5;
            else if (state === 2 && (assetType === 'Hay' || assetType === 'Grain')) manualMultiplier = 2;
  
      // Calculate and populate the cells for each roll
      baseValues[assetType].forEach((value, rollIndex) => {
                const profit = quantity * value * multiplier * manualMultiplier; // Calculate the profit
                const payoutCell = row.cells[rollIndex + 1];
                if (!payoutCell) return;

                // Make each payout cell contain a real button so it behaves like a button on mobile.
                let payoutButton = payoutCell.querySelector('button.roll-cell-button');
                if (!payoutButton) {
                        payoutCell.textContent = '';
                        payoutButton = document.createElement('button');
                        payoutButton.type = 'button';
                        payoutButton.className = 'roll-cell-button';
                        payoutCell.appendChild(payoutButton);
                }

                payoutButton.textContent = numberWithCommasAndDecimals(profit); // Populate the button with formatted profit
      });
    });
  }

  
  // Call this function to populate the roll table when the page loads or when quantities update
  populateRollTable();
  
  // Attach an input event listener to each editable quantity cell to update the roll table on change
  document.querySelectorAll('#spreadsheet .editable').forEach(cell => {
    cell.addEventListener('input', populateRollTable);
  });

// Call this function to populate the roll table when the page loads or when quantities update
populateRollTable();

function getBaseState() {
    return {
        qty: {
            Hay: 1,
            Grain: 1,
            Fruit: 0,
            Farm: 0,
            Cows: 0,
            Harvester: 0,
            Tractor: 0
        },
        ranchRidgeBonus: 0,
        ranchRidgeSelections: {
            ahtanum: false,
            rattlesnake: false,
            cascades: false,
            toppenish: false
        },
        transactions: {
            cash: ['5000'],
            loan: ['5000']
        },
        username: ''
    };
}

let data = getBaseState();

function getRanchRidgeBonusFromSelections(selections) {
    if (!selections) return 0;
    const bonusByKey = {
        ahtanum: 2,
        rattlesnake: 3,
        cascades: 4,
        toppenish: 5
    };
    return Object.keys(bonusByKey).reduce((sum, key) => {
        return sum + (selections[key] ? bonusByKey[key] : 0);
    }, 0);
}

function saveQuantitiesToLocalStorage() {
    // Update quantities from the page
    data.qty = {
        Hay: parseInt(document.querySelector('.qty-hay').textContent) || 0,
        Grain: parseInt(document.querySelector('.qty-grain').textContent) || 0,
        Fruit: parseInt(document.querySelector('.qty-fruit').textContent) || 0,
        Farm: parseInt(document.querySelector('.qty-farm').textContent) || 0,
        Cows: parseInt(document.querySelector('.qty-cows').textContent) || 0,
        Harvester: parseInt(document.querySelector('.qty-harvester').textContent) || 0,
        Tractor: parseInt(document.querySelector('.qty-tractor').textContent) || 0
    };
    
    const usernameCell = document.getElementById('editableUsername');
    data.username = usernameCell.innerText.trim() === 'Enter name' ? '' : usernameCell.innerText.trim();

    const ridgeCheckboxes = document.querySelectorAll('.ranch-ridge-checkbox');
    if (ridgeCheckboxes.length > 0) {
        if (!data.ranchRidgeSelections) data.ranchRidgeSelections = {};
        ridgeCheckboxes.forEach((cb) => {
            const key = cb.getAttribute('data-key');
            if (key) data.ranchRidgeSelections[key] = cb.checked;
        });
        data.ranchRidgeBonus = getRanchRidgeBonusFromSelections(data.ranchRidgeSelections);
    }

    // Transactions are already maintained in the global data object
    // Don't read from DOM as it only shows 10 entries
    // console.log("Data to be saved:", data);
    // Save the updated data to localStorage
    localStorage.setItem('farmingGameData', JSON.stringify(data));
}

  
function getTransactionData(transactionClass) {
    const transactionCells = document.querySelectorAll(`.${transactionClass}`);
    const transactions = Array.from(transactionCells).map(cell => cell.textContent);
    // Save all transactions - totals need to reflect all entries
    return transactions;
}
 
document.querySelectorAll('.cash-transaction, .loan-transaction').forEach(cell => {
    cell.addEventListener('blur', saveQuantitiesToLocalStorage);
});

function loadFromLocalStorage() {
    const savedData = localStorage.getItem('farmingGameData');
    if (savedData) {
        const loadedData = JSON.parse(savedData);
        // Update the global data object
        data = loadedData;
        // Apply quantity data to the page
        document.querySelector('.qty-hay').textContent = data.qty.Hay.toString();
        document.querySelector('.qty-grain').textContent = data.qty.Grain.toString();
        document.querySelector('.qty-fruit').textContent = data.qty.Fruit.toString();
        // Ensure you have a .qty-farm and .qty-cows class elements in your HTML
        document.querySelector('.qty-farm').textContent = data.qty.Farm.toString();
        document.querySelector('.qty-cows').textContent = data.qty.Cows.toString();
        document.querySelector('.qty-harvester').textContent = data.qty.Harvester.toString();
        document.querySelector('.qty-tractor').textContent = data.qty.Tractor.toString();

        // Restore ranch ridge selection (do not re-apply bonus; qty already includes it)
        if (!data.ranchRidgeSelections) data.ranchRidgeSelections = getBaseState().ranchRidgeSelections;
        if (loadedData.ranchRidgeSelections) data.ranchRidgeSelections = loadedData.ranchRidgeSelections;
        data.ranchRidgeBonus = typeof loadedData.ranchRidgeBonus === 'number'
            ? loadedData.ranchRidgeBonus
            : getRanchRidgeBonusFromSelections(data.ranchRidgeSelections);

        const ridgeCheckboxes = document.querySelectorAll('.ranch-ridge-checkbox');
        ridgeCheckboxes.forEach((cb) => {
            const key = cb.getAttribute('data-key');
            if (!key) return;
            cb.checked = !!data.ranchRidgeSelections?.[key];
        });
        
        // Update the transaction lists
        updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
        populateRollTable();
        const usernameCell = document.getElementById('editableUsername');
        usernameCell.innerText = loadedData.username || 'Enter name';
        // Debugging: Log out loaded transaction data
        // console.log("Loaded transactions for cash:", loadedData.transactions.cash);
        // console.log("Loaded transactions for loan:", loadedData.transactions.loan);
        updateTotals();
        calculateNet();
    } else {
        // First run: seed with a default starting state.
        data = getBaseState();
        localStorage.setItem('farmingGameData', JSON.stringify(data));

        document.querySelector('.qty-hay').textContent = data.qty.Hay.toString();
        document.querySelector('.qty-grain').textContent = data.qty.Grain.toString();
        document.querySelector('.qty-fruit').textContent = data.qty.Fruit.toString();
        document.querySelector('.qty-farm').textContent = data.qty.Farm.toString();
        document.querySelector('.qty-cows').textContent = data.qty.Cows.toString();
        document.querySelector('.qty-harvester').textContent = data.qty.Harvester.toString();
        document.querySelector('.qty-tractor').textContent = data.qty.Tractor.toString();

        updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });

        const usernameCell = document.getElementById('editableUsername');
        usernameCell.innerText = 'Enter name';

        const ridgeCheckboxes = document.querySelectorAll('.ranch-ridge-checkbox');
        ridgeCheckboxes.forEach((cb) => { cb.checked = false; });

        populateRollTable();
        updateTotals();
        calculateNet();
    }
}

function updateTransactionLists(transactionsData) {
    const table = document.getElementById('financialTable'); // Ensure this is the correct ID of your table

    // Clear existing transactions except the first row which is for input
    clearTransactionsExceptFirst('cash-transaction');
    clearTransactionsExceptFirst('loan-transaction');

    // Define a function to update a single transaction list
    const updateSingleTransactionList = (transactions, transactionClass) => {
        const safeTransactions = Array.isArray(transactions) ? transactions : [];
        // Limit transactions to last 10
        const limitedTransactions = safeTransactions.slice(0, 10);
        limitedTransactions.forEach((transactionValue, index) => {
            // Table layout in index.html:
            // Row 0 = cash/loan inputs
            // Row 1 = Transaction / Total headers
            // Row 2 = first transaction row
            let row = table.rows[index + 2];
            if (!row) {
                row = table.insertRow();
                createTransactionCell(row, 'cash-transaction', '', true);
                createTransactionCell(row, 'cash-total');
                createTransactionCell(row, 'loan-transaction', '', true);
                createTransactionCell(row, 'loan-total', '', true);
            }

            // Update the cell value for the transaction
            const transactionCell = row.querySelector(`.${transactionClass}`);
            if (transactionCell) {
                // Apply formatting only if the value is not an empty string
                const cellContent = transactionValue === '' ? '' : numberWithCommasAndDecimals(transactionValue);
                transactionCell.textContent = cellContent;
            }
        });
    };

    // Update both cash and loan transactions
    updateSingleTransactionList(transactionsData.cash, 'cash-transaction');
    updateSingleTransactionList(transactionsData.loan, 'loan-transaction');

    // Remove any rows beyond the first 10 transaction rows
    // Row 0 = cash/loan inputs, Row 1 = transaction headers, Row 2 = first transaction
    const maxRows = 12; // 2 header rows + 10 transaction rows
    while (table.rows.length > maxRows) {
        table.deleteRow(table.rows.length - 1);
    }
}

// Make sure to call updateTransactionList whenever you load the data from localStorage
// For example:
loadFromLocalStorage();

// Function to show the modal
function showModal() {
    document.getElementById('resetModal').classList.remove('hidden');
}

// Function to hide the modal
function hideModal() {
    document.getElementById('resetModal').classList.add('hidden');
}

// Event listener for the reset button
document.getElementById('resetButton').addEventListener('click', showModal);

// Event listener for the confirm reset button in the modal
document.getElementById('confirmReset').addEventListener('click', function() {
    performReset();
    hideModal();
});

// Event listener for the cancel button in the modal
document.getElementById('cancelReset').addEventListener('click', hideModal);

async function resetLeaderboardForAllPlayers() {
    try {
        await authReady;

        const querySnapshot = await getDocs(collection(db, 'leaderboard'));
        const deletePromises = [];
        querySnapshot.forEach((leaderboardDoc) => {
            deletePromises.push(deleteDoc(leaderboardDoc.ref));
        });
        await Promise.all(deletePromises);
        console.log('Leaderboard reset for all players');
        hideModal();
    } catch (err) {
        console.error('Error resetting leaderboard: ', err);
    }
}

// Clicking the "Reset Game" title inside the modal resets the leaderboard.
const resetModalTitle = document.getElementById('modal-title');
if (resetModalTitle) {
    resetModalTitle.addEventListener('click', resetLeaderboardForAllPlayers);
    resetModalTitle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            resetLeaderboardForAllPlayers();
        }
    });
}

async function performReset() {
    hideModal();
    
    const baseState = getBaseState();

    // Update the data object
    data = baseState;

    // Reset quantity fields to the base state
    document.querySelector('.qty-hay').textContent = '1';
    document.querySelector('.qty-grain').textContent = '1';
    document.querySelector('.qty-fruit').textContent = '0';
    document.querySelector('.qty-farm').textContent = '0';
    document.querySelector('.qty-cows').textContent = '0';
    document.querySelector('.qty-harvester').textContent = '0';
    document.querySelector('.qty-tractor').textContent = '0';

    data.ranchRidgeBonus = 0;
    data.ranchRidgeSelections = getBaseState().ranchRidgeSelections;
    document.querySelectorAll('.ranch-ridge-checkbox').forEach((cb) => { cb.checked = false; });

    const ranchRidgeMenu = document.getElementById('ranchRidgeMenu');
    const ranchRidgeButton = document.getElementById('ranchRidgeButton');
    if (ranchRidgeMenu) ranchRidgeMenu.classList.add('hidden');
    if (ranchRidgeButton) ranchRidgeButton.setAttribute('aria-expanded', 'false');

    // Clear transaction fields
    document.querySelectorAll('.cash-transaction, .loan-transaction').forEach(cell => {
        cell.textContent = '';
    });

    // Remove all rows except the first one for transactions
    clearTransactionsExceptFirst('cash-transaction');
    clearTransactionsExceptFirst('loan-transaction');

    // Set initial transaction values
    const firstCashCell = document.querySelector('.cash-transaction');
    const firstLoanCell = document.querySelector('.loan-transaction');
    if (firstCashCell) firstCashCell.textContent = '5000';
    if (firstLoanCell) firstLoanCell.textContent = '5000';

    // Note: Game reset should NOT wipe the global leaderboard.
    // After resetting local state, the normal net worth save flow will update only this player's entry.
    
    // Save the reset state to localStorage
    localStorage.setItem('farmingGameData', JSON.stringify(baseState));

    // Update totals and other calculations
    updateTotals(); // Updates all totals
    calculateNet();
    // updateNetCash();
    // Repopulate the roll table
    populateRollTable();
}


function clearTransactionsExceptFirst(transactionClass) {
    const table = document.getElementById('financialTable'); // Use the correct ID for your table
    // Avoid relying on the CSS :has() selector (not supported in all browsers).
    const rows = Array.from(table.rows).filter(row => row.querySelector(`.${transactionClass}`));
    
    // Remove all rows except the first one with transaction class
    rows.forEach((row, index) => {
        if (index > 0) {
            row.remove();
        } else {
            // Clear the content of the first row's cells
            const cells = row.querySelectorAll(`.${transactionClass}`);
            cells.forEach(cell => {
                cell.textContent = '';
                // Ensure that the first cell is editable if necessary
                cell.contentEditable = 'true';
            });
        }
    });
}

// document.getElementById('resetButton').addEventListener('click', resetData); 

document.querySelectorAll('.editable').forEach(cell => {
    cell.addEventListener('input', saveQuantitiesToLocalStorage);
});

// Load data when the document is fully loaded
document.addEventListener('DOMContentLoaded', loadFromLocalStorage);


const editableUsernameEl = document.getElementById('editableUsername');
if (editableUsernameEl && editableUsernameEl.dataset.usernameHandlersBound !== '1') {
        editableUsernameEl.dataset.usernameHandlersBound = '1';

        editableUsernameEl.addEventListener('focus', function() {
                const defaultText = 'Enter name';
                if (this.innerText === defaultText) {
                        window.getSelection().selectAllChildren(this);
                }
        });

        editableUsernameEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                        e.preventDefault();
                        editableUsernameEl.blur();
                        commitUsernameEdit();
                }
        });

        editableUsernameEl.addEventListener('blur', commitUsernameEdit);
}

window.addEventListener('DOMContentLoaded', (event) => {
    // Attach event listeners to quantity cells
    const qtyCells = document.querySelectorAll('#spreadsheet .editable');
    qtyCells.forEach(cell => {
        cell.addEventListener('input', calculateNet);
    });
    document.querySelectorAll('#spreadsheet .editable').forEach(cell => {
        cell.addEventListener('input', calculateNet);
        cell.addEventListener('input', populateRollTable);
    });

    calculateNet(); // Initial calculation on page load
    //console.log(document.getElementById('cashInput'));
    makeEditableCellsExitOnEnter();
    const cashUndoCell = document.getElementById('cashUndoCell');
    if (cashUndoCell) {
        cashUndoCell.addEventListener('click', undoLastCashTransaction);
    }
    const loanUndoCell = document.getElementById('loanUndoCell');
    if (loanUndoCell) {
        loanUndoCell.addEventListener('click', undoLastLoanTransaction);
    }
    const cashInput = document.getElementById('cashInput');
    if (cashInput) {
        const quickTxButtons = document.querySelectorAll('[data-quick-transaction-value]');
        quickTxButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const rawValue = btn.getAttribute('data-quick-transaction-value');
                if (!rawValue) return;
                cashInput.value = rawValue;
                handleTransaction('cashInput', 'cash-transaction', 'cash-total');
            });
        });

        // Make roll table payout buttons clickable to add as cash transactions.
        // Use event delegation so it keeps working even if buttons are created later.
        const rollTable = document.querySelector('.roll-table');
        if (rollTable && rollTable.dataset.rollClickBound !== '1') {
            rollTable.dataset.rollClickBound = '1';
            rollTable.addEventListener('click', (e) => {
                let btn = e.target;
                
                // Check if the clicked element is a button or inside a button
                if (btn.tagName !== 'BUTTON') {
                    btn = btn.closest('button.roll-cell-button');
                }
                
                if (!btn || !btn.classList.contains('roll-cell-button')) {
                    return;
                }

                // Debug logging to trace roll button clicks
                console.log('Roll button clicked');

                const text = (btn.textContent || '').trim();
                if (!text) return;

                const numericText = text.replace(/,/g, '');
                const value = parseFloat(numericText);
                if (!Number.isFinite(value)) {
                    console.warn('Roll button value not finite', { text, numericText });
                    return;
                }

                // Sandbox preview blocks confirm(), so just add automatically.
                addCashTransactionValue(value);
                console.log(`Roll payout ${text} added to cash transactions`);
            });
        }

        cashInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                //console.log('Enter pressed on cashInput');
                handleTransaction('cashInput', 'cash-transaction', 'cash-total');
                cashInput.blur();
                e.preventDefault();
            }
        });
        cashInput.addEventListener('blur', () => {
            if (cashInput.value.trim() !== '') {
                handleTransaction('cashInput', 'cash-transaction', 'cash-total');
            }
        });
    }

    const loanInput = document.getElementById('loanInput');
    if (loanInput) {
        loanInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                handleTransaction('loanInput', 'loan-transaction', 'loan-total');
                loanInput.blur();
                e.preventDefault();
            }
        });
        loanInput.addEventListener('blur', () => {
            if (loanInput.value.trim() !== '') {
                handleTransaction('loanInput', 'loan-transaction', 'loan-total');
            }
        });
    }
    const transactionCells = document.querySelectorAll('.cash-transaction, .loan-transaction');
    transactionCells.forEach(makeCellEditable);

    const payInterestBtn = document.getElementById('payInterestBtn');
    if (payInterestBtn) {
        payInterestBtn.addEventListener('click', () => {
            // Ensure interest/cash totals are fresh
            updateTotals();

            const interest = getCurrentInterestValue();
            if (!(interest > 0)) return;

            const currentCash = getCurrentCashTotal();
            if (currentCash < interest) {
                alert(
                    'Insufficient cash to pay interest. You need $' +
                        interest.toLocaleString() +
                        ' but only have $' +
                        currentCash.toLocaleString() +
                        '.'
                );
                return;
            }

            addCashTransactionValue(-interest);
        });
    }

    // Add event listeners for quantity +/- buttons
    document.querySelectorAll('.qty-btn').forEach(button => {
        button.addEventListener('click', function() {
            const targetClass = this.getAttribute('data-target');
            const qtyCell = document.querySelector(`.${targetClass}`);
            if (qtyCell) {
                let currentQty = parseInt(qtyCell.textContent) || 0;
                if (this.classList.contains('qty-plus')) {
                    currentQty++;
                } else if (this.classList.contains('qty-minus')) {
                    currentQty = Math.max(0, currentQty - 1); // Don't go below 0
                }
                qtyCell.textContent = currentQty;
                calculateNet();
                populateRollTable();
                saveQuantitiesToLocalStorage();
            }
        });
    });

    // Add event listeners for roll table asset taps
    const rollTable = document.querySelector('.roll-table');
    const assetTds = rollTable.querySelectorAll('tr:not(:first-child) td:first-child');
    assetTds.forEach(td => {
        td.addEventListener('click', () => {
            const asset = td.textContent.split(' ')[0];
            let state = parseInt(td.getAttribute('data-state') || 0);
            if (asset === 'Fruit' || asset === 'Cows') {
                state = (state + 1) % 2; // Only 0 and 1
            } else {
                state = (state + 1) % 3; // 0, 1, 2
            }
            td.setAttribute('data-state', state);
            updateAssetDisplay(td, state);
            populateRollTable();
        });
    });

    function updateAssetDisplay(td, state) {
        const asset = td.textContent.split(' ')[0]; // Get base asset name
        if (state === 0) {
            td.textContent = asset;
            td.style.color = '';
            td.style.backgroundColor = '';
        } else if (state === 1) {
            td.textContent = asset + ' x1/2';
            td.style.color = 'red';
            td.style.backgroundColor = '';
        } else if (state === 2 && (asset === 'Hay' || asset === 'Grain')) {
            td.textContent = asset + ' x2';
            td.style.color = 'green';
            td.style.backgroundColor = '';
        }
    }

    // Add event listeners for buy buttons
    document.querySelectorAll('.buy-btn').forEach(button => {
        button.addEventListener('click', function() {
            const asset = this.getAttribute('data-asset');
            const row = this.closest('tr');
            const qtyCell = row.cells[2]; // Qty column
            const costCell = row.cells[3]; // Cost column
            const qtyValueEl = qtyCell.querySelector('span.editable');
            const costRaw = costCell.textContent.replace(/,/g, '').trim();
            const cost = parseFloat(costRaw) || 0;
            const totalCost = cost; // Always buy 1
            if (totalCost <= 0) {
                alert('Cost is invalid.');
                return;
            }

            // Show modal
            showBuyModal(asset, cost, totalCost);
        });
    });

    // Modal event listeners
    const buyModal = document.getElementById('buyModal');
    const downPaymentSlider = document.getElementById('downPaymentSlider');
    const confirmBuy = document.getElementById('confirmBuy');
    const cancelBuy = document.getElementById('cancelBuy');

    let currentAsset, currentCost, currentTotalCost, currentQtyValueEl, currentBaseCost;
    let lastDownPaymentPercent = 20; // Remember last setting
    let lastDownPaymentAmount = 0; // Remember last dollar amount
    let minValidDownPayment = 0;

    function showBuyModal(asset, cost, totalCost) {
        currentAsset = asset;
        currentBaseCost = cost; // Base cost
        currentCost = cost;
        currentTotalCost = totalCost;

        // Find the qty span for this asset
        const qtySpan = document.querySelector(`.qty-${asset}`);
        currentQtyValueEl = qtySpan;

        document.getElementById('modalTitle').textContent = `Buy ${asset.charAt(0).toUpperCase() + asset.slice(1)}`;
        document.getElementById('assetInfo').textContent = `Buying 1 ${asset} at $${cost.toLocaleString()} each.`;
        document.getElementById('totalCost').textContent = totalCost.toLocaleString();
        
        // Show ridge select for Ranch Cows
        const ridgeDiv = document.getElementById('ridgeSelectDiv');
        const ridgeSelect = document.getElementById('ridgeSelect');
        if (asset === 'cows') {
            ridgeDiv.classList.remove('hidden');
            ridgeSelect.value = 'none'; // Reset to none
            updateRidgeCost();
        } else {
            ridgeDiv.classList.add('hidden');
        }
        
        // Debt cap: total debt can't exceed $50,000
        updateTotals();
        const currentLoanTotal = getCurrentLoanTotal();
        const maxLoanIncrease = 50000 - currentLoanTotal;

        // Minimum down payment: max of 20% of cost or amount needed to keep loan <= $50,000
        const minFromLoanLimit = Math.max(0, totalCost - maxLoanIncrease);
        const minFromPercentage = totalCost * 0.2;
        minValidDownPayment = Math.max(minFromLoanLimit, minFromPercentage);
        // Snap to $100 increments
        minValidDownPayment = Math.ceil(minValidDownPayment / 100) * 100;

        downPaymentSlider.step = 100;
        downPaymentSlider.min = Math.min(minValidDownPayment, totalCost);
        downPaymentSlider.max = totalCost;

        const minVal = parseInt(downPaymentSlider.min);
        const maxVal = parseInt(downPaymentSlider.max);
        const desired = Number.isFinite(lastDownPaymentAmount) ? lastDownPaymentAmount : minVal;
        let chosen = Math.min(Math.max(desired, minVal), maxVal);
        chosen = Math.round(chosen / 100) * 100;
        downPaymentSlider.value = chosen;

        // Update display
        document.getElementById('minDownPayment').textContent = Number(downPaymentSlider.min).toLocaleString();
        document.getElementById('maxDownPayment').textContent = Number(downPaymentSlider.max).toLocaleString();
        
        updateModalAmounts(parseInt(downPaymentSlider.value));
        buyModal.classList.remove('hidden');
    }

    function updateRidgeCost() {
        const ridgeSelect = document.getElementById('ridgeSelect');
        const selectedRidge = ridgeSelect.value;
        let bonus = 0;
        if (selectedRidge !== 'none') {
            const checkbox = document.querySelector(`.ranch-ridge-checkbox[data-key="${selectedRidge}"]`);
            bonus = parseInt(checkbox.getAttribute('data-bonus')) || 0;
        }
        // Cost = bonus * 10000
        const ridgeCost = bonus * 10000;
        currentCost = ridgeCost;
        currentTotalCost = ridgeCost;
        document.getElementById('assetInfo').textContent = `Buying 1 ${currentAsset} at $${ridgeCost.toLocaleString()} each.`;
        document.getElementById('totalCost').textContent = ridgeCost.toLocaleString();
        
        // Recalculate slider range for debt cap
        updateTotals();
        const currentLoanTotal = getCurrentLoanTotal();
        const maxLoanIncrease = 50000 - currentLoanTotal;

        // Minimum down payment: max of 20% of cost or amount needed to keep loan <= $50,000
        const minFromLoanLimit = Math.max(0, ridgeCost - maxLoanIncrease);
        const minFromPercentage = ridgeCost * 0.2;
        minValidDownPayment = Math.max(minFromLoanLimit, minFromPercentage);
        minValidDownPayment = Math.ceil(minValidDownPayment / 100) * 100;

        downPaymentSlider.step = 100;
        downPaymentSlider.min = Math.min(minValidDownPayment, ridgeCost);
        downPaymentSlider.max = ridgeCost;

        document.getElementById('minDownPayment').textContent = Number(downPaymentSlider.min).toLocaleString();
        document.getElementById('maxDownPayment').textContent = Number(downPaymentSlider.max).toLocaleString();

        const minVal = parseInt(downPaymentSlider.min);
        const maxVal = parseInt(downPaymentSlider.max);
        let chosen = Math.min(Math.max(parseInt(downPaymentSlider.value), minVal), maxVal);
        chosen = Math.round(chosen / 100) * 100;
        downPaymentSlider.value = chosen;
        
        updateModalAmounts(parseInt(downPaymentSlider.value));
    }

    // Add event listener for ridge select
    document.getElementById('ridgeSelect').addEventListener('change', updateRidgeCost);

    function updateModalAmounts(downPaymentAmount) {
        const downPayment = downPaymentAmount;
        const loanAmount = Math.round(currentTotalCost - downPayment);
        document.getElementById('downPaymentAmount').textContent = downPayment.toLocaleString();
        document.getElementById('downPaymentSummary').textContent = downPayment.toLocaleString();
        document.getElementById('loanAmount').textContent = loanAmount.toLocaleString();
    }

    downPaymentSlider.addEventListener('input', function() {
        const downPaymentAmount = parseInt(this.value);
        updateModalAmounts(downPaymentAmount);
    });

    confirmBuy.addEventListener('click', function() {
        const downPayment = parseInt(downPaymentSlider.value);
        lastDownPaymentAmount = downPayment; // Remember for next time
        const loanAmount = Math.round(currentTotalCost - downPayment);

        // Check if user has enough cash for down payment
        updateTotals();
        const currentCash = getCurrentCashTotal();
        if (currentCash < downPayment) {
            alert('Insufficient cash for down payment. You need $' + downPayment.toLocaleString() + ' but only have $' + currentCash.toLocaleString() + '.');
            return;
        }

        // Check if loan would exceed $50,000 debt limit
        const currentLoanTotal = getCurrentLoanTotal();
        if (currentLoanTotal + loanAmount > 50000) {
            alert('Loan would exceed the $50,000 debt limit. Current debt: $' + currentLoanTotal.toLocaleString() + ', Additional loan: $' + loanAmount.toLocaleString() + '.');
            return;
        }

        // Add cash transaction (negative for payment)
        addCashTransactionValue(-downPayment);
        // Add loan transaction (positive for loan)
        addLoanTransactionValue(loanAmount);

        // Increment the quantity
        let currentQty = parseInt(currentQtyValueEl.textContent) || 0;
        currentQty += 1;
        currentQtyValueEl.textContent = currentQty;
        calculateNet();
        populateRollTable();
        saveQuantitiesToLocalStorage();

        // For Ranch Cows, check the selected ridge
        let ridgeMsg = '';
        if (currentAsset === 'cows') {
            const ridgeSelect = document.getElementById('ridgeSelect');
            const selectedRidge = ridgeSelect.value;
            if (selectedRidge !== 'none') {
                const checkbox = document.querySelector(`.ranch-ridge-checkbox[data-key="${selectedRidge}"]`);
                if (checkbox) checkbox.checked = true;
                const ridgeName = ridgeSelect.options[ridgeSelect.selectedIndex].text;
                ridgeMsg = ` (${ridgeName})`;
            }
        }

        alert(`Purchased 1 ${currentAsset}${ridgeMsg} for $${currentTotalCost.toLocaleString()}. Down payment: $${downPayment.toLocaleString()}, Loan: $${loanAmount.toLocaleString()}`);
        buyModal.classList.add('hidden');
    });

    cancelBuy.addEventListener('click', function() {
        buyModal.classList.add('hidden');
    });

    const ranchRidgeButton = document.getElementById('ranchRidgeButton');
    const ranchRidgeMenu = document.getElementById('ranchRidgeMenu');
    const ridgeCheckboxes = document.querySelectorAll('.ranch-ridge-checkbox');

    function setRanchRidgeMenuOpen(isOpen) {
        if (!ranchRidgeMenu || !ranchRidgeButton) return;
        ranchRidgeMenu.classList.toggle('hidden', !isOpen);
        ranchRidgeButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    if (ranchRidgeButton && ranchRidgeMenu) {
        ranchRidgeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isOpen = !ranchRidgeMenu.classList.contains('hidden');
            setRanchRidgeMenuOpen(!isOpen);
        });

        document.addEventListener('click', (e) => {
            if (!ranchRidgeMenu.classList.contains('hidden')) {
                const clickedInside = ranchRidgeMenu.contains(e.target) || ranchRidgeButton.contains(e.target);
                if (!clickedInside) setRanchRidgeMenuOpen(false);
            }
        });
    }

    if (ridgeCheckboxes.length > 0) {
        ridgeCheckboxes.forEach((cb) => {
            cb.addEventListener('change', () => {
                const prevBonus = data.ranchRidgeBonus || 0;
                if (!data.ranchRidgeSelections) data.ranchRidgeSelections = {};

                ridgeCheckboxes.forEach((box) => {
                    const key = box.getAttribute('data-key');
                    if (key) data.ranchRidgeSelections[key] = box.checked;
                });

                const newBonus = getRanchRidgeBonusFromSelections(data.ranchRidgeSelections);

                const ranchCowsQtyEl = document.querySelector('.qty-cows');
                if (!ranchCowsQtyEl) return;
                const currentQty = parseInt(ranchCowsQtyEl.textContent, 10) || 0;
                const updatedQty = Math.max(0, currentQty - prevBonus + newBonus);
                ranchCowsQtyEl.textContent = updatedQty.toString();

                data.ranchRidgeBonus = newBonus;
                calculateNet();
                populateRollTable();
                saveQuantitiesToLocalStorage();
            });
        });
    }

    // Initial total calculation
    updateTotals();
    // If you have a loanInput similar to cashInput, initialize it here as well.
});
