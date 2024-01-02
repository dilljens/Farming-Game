function calculateNet() {
    //console.log('Calculating net values...');
    const rows = document.querySelectorAll('#spreadsheet tr');

    rows.forEach((row, index) => {
        if (index > 0 && index < rows.length - 3) {
            const qtyCell = row.cells[1];
            const costCell = row.cells[2];
            const netCell = row.cells[3];

            const qty = parseFloat(qtyCell.innerText.replace(/,/g, '')) || 0;
            const cost = parseFloat(costCell.innerText.replace(/,/g, '')) || 0;
            const net = qty * cost;

            if (netCell) {
                netCell.textContent = numberWithCommasAndDecimals(net);
            }
        }
    });

    updateTotalWorth(); // Update the total worth after net values are calculated
}



function handleTransaction(inputId, transactionClass, totalClass) {
    const inputElement = document.getElementById(inputId);
    if (inputElement && inputElement.value.trim() !== '') {
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
        // Clear the input field after the transaction is added
        inputElement.value = '';
    }
}

function shiftAndInsertTransaction(inputId, transactionClass) {
    // Get the value from the input
    const inputElement = document.getElementById(inputId);
    const newValue = inputElement.value.trim();

    // Check that the value is not empty
    if (newValue !== '') {
        // Select all the transaction cells for cash or loan
        const transactionCells = document.querySelectorAll(`.${transactionClass}`);
        
        // Shift the transaction values down by one cell
        for (let i = transactionCells.length - 1; i > 0; i--) {
            transactionCells[i].textContent = transactionCells[i - 1].textContent;
        }

        // Insert the new value at the top
        if (transactionCells.length > 0) {
            transactionCells[0].textContent = newValue;
        }

        // Clear the input element
        inputElement.value = '';

        // After shifting values, recalculate the total
        // updateTotal(transactionClass);
        updateTotals();
        // Example usage in shiftAndInsertTransaction
        transactionCells[0].textContent = numberWithCommasAndDecimals(newValue);

    }
}

function makeCellEditable(cell) {
    cell.contentEditable = 'true';
    
    // Event listener for input events to update the total immediately after a change
    cell.addEventListener('input', () => {
        updateTotals();
    });

    // Event listener for keydown events to handle the Enter key
    cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent the default Enter key action
            cell.blur(); // Remove focus from the cell
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

function updateTotals() {
    // Define the classes for both cash and loan transactions and their corresponding totals
    const transactionTypes = [
        { transactionClass: 'cash-transaction', totalClass: 'cash-total' },
        { transactionClass: 'loan-transaction', totalClass: 'loan-total' }
    ];

    // Iterate over each transaction type and update their totals
    transactionTypes.forEach(({ transactionClass, totalClass }) => {
        const transactions = document.querySelectorAll(`.${transactionClass}`);
        let sum = 0;

        transactions.forEach(cell => {
            let cellValue = parseFloat(cell.textContent.replace(/,/g, '')) || 0;
            sum += cellValue;
        });

        const totalCell = document.querySelector(`.${totalClass}`);
        if (totalCell) {
            totalCell.textContent = numberWithCommasAndDecimals(sum);
        }
    });

    // Update net cash, total worth, and interest after updating totals
    updateNetCash();
    updateTotalWorth();
    updateInterest();
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

function updateTotalWorth() {
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
}

function makeEditableCellsExitOnEnter() {
    const editableCells = document.querySelectorAll('td.editable');

    editableCells.forEach(cell => {
        cell.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Prevent default action (newline or navigation)
                cell.blur(); // Unfocus the cell, exiting edit mode
                calculateNet(); // Recalculate net values if needed
                updateTotalWorth(); // Recalculate total worth if needed
            }
        });
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
      const assetType = row.cells[0].textContent; // Get the asset type (Hay, Grain, etc.)
      const quantity = quantities[assetType] || 0; // Get the quantity for this asset type
  
      // Calculate and populate the cells for each roll
      baseValues[assetType].forEach((value, rollIndex) => {
        const profit = quantity * value; // Calculate the profit
        row.cells[rollIndex + 1].textContent = numberWithCommasAndDecimals(profit); // Populate the cell with the formatted profit
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

let data = {
    qty: {
        hay: 1,
        grain: 1,
        fruit: 0,
        farm: 0,
        cows: 0,
        harvester: 0,
        tractor: 0
    },
    transactions: {
        cash: [],
        loan: []
    }
};

function saveQuantitiesToLocalStorage() {
    // Get the current quantities from the page
    const data = {
      qty: {
        Hay: parseInt(document.querySelector('.qty-hay').textContent) || 0,
        Grain: parseInt(document.querySelector('.qty-grain').textContent) || 0,
        Fruit: parseInt(document.querySelector('.qty-fruit').textContent) || 0,
        Farm: parseInt(document.querySelector('.qty-farm').textContent) || 0,
        Cows: parseInt(document.querySelector('.qty-cows').textContent) || 0,
        Harvester: parseInt(document.querySelector('.qty-harvester').textContent) || 0,
        Tractor: parseInt(document.querySelector('.qty-tractor').textContent) || 0
      },
      transactions: {
        cash: getTransactionData('cash-transaction'),
        loan: getTransactionData('loan-transaction')
      }
    };
    console.log("Data to be saved:", data);
    // Save the updated data to localStorage
    localStorage.setItem('farmingGameData', JSON.stringify(data));
}

  
function getTransactionData(transactionClass) {
    const transactionCells = document.querySelectorAll(`.${transactionClass}`);
    const transactions = Array.from(transactionCells).map(cell => cell.textContent);
    console.log(`Transactions for ${transactionClass}:`, transactions); // Debugging
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
        
        // Update the transaction lists
        // This assumes you have a function to update the transaction list on the page
        updateTransactionList(loadedData.transactions.cash, 'cash');
        updateTransactionList(loadedData.transactions.loan, 'loan');
        populateRollTable();
        // Debugging: Log out loaded transaction data
        console.log("Loaded transactions for cash:", loadedData.transactions.cash);
        console.log("Loaded transactions for loan:", loadedData.transactions.loan);
    }
}
function updateTransactionList(transactions, type) {
    const table = document.getElementById('financialTable');
    const transactionRowsSelector = type === 'cash' ? '.cash-transaction-row' : '.loan-transaction-row';

    // Remove previous transaction rows of the specified type
    document.querySelectorAll(transactionRowsSelector).forEach(row => row.remove());

    // Add new transaction rows
    transactions.forEach(transaction => {
        const newRow = table.insertRow();
        newRow.classList.add(`${type}-transaction-row`);

        if (type === 'cash') {
            createTransactionCell(newRow, 'cash-transaction', transaction);
            createTransactionCell(newRow, 'cash-total'); // Total cell, update as needed
            createTransactionCell(newRow, 'loan-transaction', '', true); // Empty cell for alignment
            createTransactionCell(newRow, 'loan-total', '', true); // Empty cell for alignment
        } else { // For 'loan'
            createTransactionCell(newRow, 'cash-transaction', '', true); // Empty cell for alignment
            createTransactionCell(newRow, 'cash-total', '', true); // Empty cell for alignment
            createTransactionCell(newRow, 'loan-transaction', transaction);
            createTransactionCell(newRow, 'loan-total'); // Total cell, update as needed
        }
    });
}

function createTransactionCell(row, className, value = '', isEditable = false) {
    const cell = row.insertCell();
    cell.className = className;
    cell.textContent = value;
    if (isEditable) {
        makeCellEditable(cell);
    }
}

// Make sure to call updateTransactionList whenever you load the data from localStorage
// For example:
loadFromLocalStorage();

function resetData() {
    // Define your base state
    const baseState = {
        qty: {
            Hay: 1, Grain: 1, Fruit: 0, Farm: 0, Cows: 0, Harvester: 0, Tractor: 0
        },
        transactions: {
            cash: [],
            loan: []
        }
    };

    // Update the data object
    data = baseState;

    // Update the UI accordingly
    // Reset quantity fields to the base state
    document.querySelector('.qty-hay').textContent = '1';
    document.querySelector('.qty-grain').textContent = '1';
    document.querySelector('.qty-fruit').textContent = '0';
    document.querySelector('.qty-farm').textContent = '0';
    document.querySelector('.qty-cows').textContent = '0';
    document.querySelector('.qty-harvester').textContent = '0';
    document.querySelector('.qty-tractor').textContent = '0';

    // Clear transaction fields
    document.querySelectorAll('.cash-transaction, .loan-transaction').forEach(cell => {
        cell.textContent = '';
    });
    // Remove all rows except the first one
    // clearTransactionsExceptFirst(cashTransactions);
    // clearTransactionsExceptFirst(loanTransactions);
    localStorage.setItem('farmingGameData', JSON.stringify(baseState));
    // Update totals and other calculations
    updateTotals(); // This function should replace updateNetCash, updateTotalWorth, and updateInterest if it updates all totals as previously defined
    calculateNet();
    updateNetCash();
    updateTotalWorth();
    updateInterest();

    // Save the reset state to localStorage

    // Repopulate the roll table
    populateRollTable();
}

document.getElementById('resetButton').addEventListener('click', resetData); 

document.querySelectorAll('.editable').forEach(cell => {
    cell.addEventListener('input', saveQuantitiesToLocalStorage);
});

// Load data when the document is fully loaded
document.addEventListener('DOMContentLoaded', loadFromLocalStorage);


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
    const cashInput = document.getElementById('cashInput');
    cashInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            //console.log('Enter pressed on cashInput');
            handleTransaction('cashInput', 'cash-transaction', 'cash-total');
            cashInput.blur();
            e.preventDefault();
        }
    });
    loanInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          handleTransaction('loanInput', 'loan-transaction', 'loan-total');
          loanInput.blur();
          e.preventDefault();
        }
    });
    const transactionCells = document.querySelectorAll('.cash-transaction, .loan-transaction');
    transactionCells.forEach(makeCellEditable);

    // Initial total calculation
    updateTotals();
    // Call this function after the page loads
    document.addEventListener('DOMContentLoaded', (event) => {
    makeEditableCellsExitOnEnter();
});
    // If you have a loanInput similar to cashInput, initialize it here as well.
});
